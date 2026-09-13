// CR-CRU-129 §S1 — a milestone is a RECORD, not an event.
//
// ── The incident this file reproduces ──────────────────────────────────────
// On 2026-09-13 this project lost every release it has ever shipped. Not to a
// crash and not to an operator: to `enforceRetention` (src/store.ts:3063)
// working exactly as designed. A release is a ROW IN `events`
// (kind='milestone', payload.type='release'); `events` is a capped ring
// buffer; one CR's worth of TDD ingests appended 165 rows and the oldest 165
// were evicted. Four of them were the `release` records for 0.1.0, 0.1.1,
// 0.1.2 and 0.1.3, four more were `cr-merged` records, and one was a live
// `release-proposal`.
//
// Every test below therefore does ONE thing: it puts structural records into a
// project, rolls the ENTIRE event buffer with ordinary test telemetry, and
// then asks the project what it remembers. Today it remembers nothing, which
// is the RED.
//
// ── What is deliberately NOT pinned here ───────────────────────────────────
// No table name, no column, no query. §S1 may store these records wherever it
// likes; what it may not do is forget them. The schema half of §S1 is asserted
// in tests/milestone-record-migration.test.ts, which is where a migration
// belongs.
//
// ── Two vocabularies are READ, never copied ────────────────────────────────
// 1. The accepted milestone types are read off the SERVER'S OWN refusal
//    (`type must be one of: …`, src/v2.ts:1264-1265), which interpolates
//    `MILESTONE_TYPES` (src/v2.ts:1165) verbatim. A test holding its own copy
//    of the list stops tracking the server the moment a type is added, and
//    would then claim survival for a vocabulary the server no longer has.
// 2. The retention cap is read back off the PROJECT after the fixture
//    configures it (`store.getProject(key).retention`). No assertion here
//    names 100, 2000 or any other number: a test that hardcodes the limit it
//    is checking freezes the same defect from the other side.
//
// 🚨 FINDING — the CR text and the code disagree about the six types.
// The spec (§S1) calls the six `MILESTONE_TYPES` "release, cr-merged,
// release-proposal, gap-analysis, design-review, custom". The actual set at
// src/v2.ts:1165-1172 is {gap-analysis, design-review, STAGE-FLIP, custom,
// cr-merged, release} — it contains `stage-flip`, which the spec omits, and it
// does NOT contain `release-proposal`, which is not a POST /milestones type at
// all but its own record written through POST …/release-proposals
// (`recordReleaseProposal`, src/store.ts:2296). Reading the vocabulary from
// the server rather than the spec makes this file correct either way, and the
// proposal is covered explicitly beside it because it is a SEVENTH record kind
// on the record side of the line, not one of the six.
//
// ── Safety ─────────────────────────────────────────────────────────────────
// Every store here is an mkdtempSync scratch file or ":memory:", and every
// server binds port 0. The live `data/crucible.db` is NEVER opened and the
// dog-food port 3849 is NEVER bound.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";
import type { Store } from "../src/store.ts";
import type { SuiteNode } from "../src/types.ts";

type AnyBody = Record<string, unknown>;

const ORCH = "orchestrator-129";
const FIXTURE_TARGET_AT = 1_788_220_800; // 2026-09-01T00:00:00Z

/**
 * The cap the FIXTURE chooses, used ONLY to configure the project through the
 * configuration surface. Nothing asserts this number: every expectation is
 * derived from the value read back off the project, so the cap stays
 * configuration and never becomes a constant this suite freezes.
 */
const FIXTURE_CAP_SMALL = 24;
const FIXTURE_CAP_BOARD = 120;

const emptyTree: SuiteNode[] = [];

describe("CR-CRU-129 §S1 — structural records survive a retention sweep that rolls the whole event buffer", () => {
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
    const dir = mkdtempSync(join(tmpdir(), "cru129-records-"));
    scratchDirs.push(dir);
    handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
    return handle;
  }

  function base(): string {
    return `http://localhost:${handle!.server.port}`;
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
    const key = (created.body.project as AnyBody | undefined)?.key as string;
    expect(typeof key).toBe("string");
    const registered = await post("/api/v2/agents/register", {
      projectKey: key,
      agentId: ORCH,
      role: "ORCHESTRATOR",
    });
    expect(registered.status).toBe(200);
    return key;
  }

  /**
   * Set the project's cap THROUGH THE CONFIGURATION SURFACE and return the
   * value the store actually resolved. Every count assertion downstream is
   * derived from this return value, never from `chosen`.
   */
  async function configureCap(key: string, chosen: number): Promise<number> {
    const patched = await fetch(`${base()}/api/v2/projects/${key}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ retention: chosen }),
    });
    expect(patched.status).toBe(200);
    const configured = handle!.store.getProject(key)?.retention;
    expect(typeof configured).toBe("number");
    return configured as number;
  }

  /**
   * The accepted milestone vocabulary, READ OFF THE SERVER — see the header.
   * The refusal is the only channel that publishes `MILESTONE_TYPES`, and it
   * publishes it verbatim.
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
        `CR-CRU-129 §S1: cannot read the accepted milestone vocabulary off the server's own ` +
          `refusal — POST /api/v2/milestones answered ${JSON.stringify(message)}. This suite ` +
          `reads MILESTONE_TYPES rather than holding a copy of it; fix the read, never pin a list.`,
      );
    }
    const types = match[1]!
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    // Non-vacuity: the CR names SIX types. A regex that matched an empty or
    // one-element list would make every loop below a no-op.
    expect(types.length).toBeGreaterThanOrEqual(6);
    return types;
  }

  async function propose(key: string, label: string): Promise<void> {
    const res = await post(`/api/v2/projects/${key}/release-proposals`, {
      agentId: ORCH,
      label,
      targetAt: FIXTURE_TARGET_AT,
    });
    expect(res.status).toBe(200);
  }

  async function milestone(key: string, body: AnyBody): Promise<string> {
    const res = await post("/api/v2/milestones", { projectKey: key, agentId: ORCH, ...body });
    expect([200, 201]).toContain(res.status);
    const id = res.body.event;
    expect(typeof id).toBe("string");
    return id as string;
  }

  async function gate(key: string, intent: string, version?: string): Promise<string> {
    const res = await post("/api/v2/gates", {
      projectKey: key,
      agentId: ORCH,
      gate: { intent, outcome: "passed", steps: [{ name: "tests", status: "passed" }] },
      ...(version !== undefined ? { version } : {}),
    });
    expect(res.status).toBe(201);
    const id = res.body.event;
    expect(typeof id).toBe("string");
    return id as string;
  }

  /**
   * Roll the WHOLE buffer with ordinary telemetry — the incident, reproduced.
   * Returns the id of the FIRST test event ingested, which every later
   * assertion uses to prove the sweep actually ran: if that row is still
   * present the buffer never rolled and the survival assertions would be
   * measuring nothing.
   */
  function rollWholeBuffer(store: Store, key: string, cap: number): { first: string; total: number } {
    // TWICE the configured cap, so every row that existed before this call —
    // structural and telemetry alike — is older than the surviving window.
    const total = cap * 2;
    let first = "";
    for (let i = 0; i < total; i++) {
      const event = store.recordTestEvent(key, ORCH, {
        summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 },
        tree: emptyTree,
      });
      if (i === 0) first = event.id;
    }
    return { first, total };
  }

  /** The sweep RAN, and it pruned telemetry — asserted in every survival test
   *  so none of them can pass by never triggering retention at all. */
  function expectBufferRolled(store: Store, key: string, cap: number, rolled: { first: string; total: number }): void {
    expect(store.getEvent(rolled.first)).toBeNull();
    const surviving = store.listEvents(key, rolled.total * 10).filter((e) => e.kind === "test");
    expect(surviving.length).toBeLessThanOrEqual(cap);
    expect(surviving.length).toBeGreaterThan(0);
  }

  /**
   * The by-id audit read, WITHOUT asserting it succeeded — the status is part
   * of the snapshot. A helper that threw on 404 would abort the comparison at
   * the first missing gate and hide the rest of the loss; carrying the status
   * makes the before/after diff show exactly which records the sweep took.
   */
  async function eventRead(id: string): Promise<{ status: number; event: unknown }> {
    const res = await get(`/api/v2/events/${id}`);
    return { status: res.status, event: res.body.event ?? null };
  }

  async function eventById(id: string): Promise<AnyBody> {
    const read = await eventRead(id);
    expect(read.status).toBe(200);
    return read.event as AnyBody;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // AC1 (the headline) — the incident itself.
  // ─────────────────────────────────────────────────────────────────────────
  test(
    "a project AT its configured cap, ingesting enough runs to roll the ENTIRE buffer, still answers " +
      "GET …/releases, GET …/release-proposals and its gate reads with every record and every `crs` byte-identical",
    async () => {
      boot();
      const key = await seedProject("cap-roll");
      const store = handle!.store;
      const cap = await configureCap(key, FIXTURE_CAP_SMALL);

      // The records: a proposal that a release will CONSUME, a proposal that
      // stays LIVE, the shipped release carrying its `crs`, and three gates —
      // versioned-live, VERSIONLESS, and retired-by-the-release.
      await propose(key, "9.9.0");
      await propose(key, "9.10.0");
      await milestone(key, {
        type: "release",
        label: "9.9.0",
        commit: "9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f9f",
        releasedAt: 1_788_000_000,
        crs: ["CR-FIXTURE-ONE", "CR-FIXTURE-TWO", "CR-FIXTURE-THREE"],
      });
      const liveGate = await gate(key, "gate for 9.10.0", "9.10.0");
      const versionlessGate = await gate(key, "gate with no release");
      const retiredGate = await gate(key, "late gate for 9.9.0", "9.9.0");

      const snapshot = async (): Promise<AnyBody> => ({
        releases: (await get(`/api/v2/projects/${key}/releases`)).body,
        proposals: (await get(`/api/v2/projects/${key}/release-proposals`)).body,
        liveGate: await eventRead(liveGate),
        versionlessGate: await eventRead(versionlessGate),
        retiredGate: await eventRead(retiredGate),
      });

      const before = (await snapshot()) as {
        releases: AnyBody;
        proposals: AnyBody;
        [k: string]: unknown;
      };
      // The fixture is real: a release with a non-empty `crs`, one live
      // proposal, three gates that all read back. Without this the comparison
      // below could hold between two empty answers.
      for (const gateKey of ["liveGate", "versionlessGate", "retiredGate"]) {
        expect((before[gateKey] as { status: number }).status).toBe(200);
      }
      expect((before.releases.releases as AnyBody[]).length).toBe(1);
      expect((before.releases.releases as AnyBody[])[0]!.crs).toEqual([
        "CR-FIXTURE-ONE",
        "CR-FIXTURE-TWO",
        "CR-FIXTURE-THREE",
      ]);
      expect((before.proposals.proposals as AnyBody[]).length).toBe(1);

      const rolled = rollWholeBuffer(store, key, cap);
      expectBufferRolled(store, key, cap, rolled);

      const after = await snapshot();

      expect(after).toEqual(before);
      // BYTE-identical, not merely deep-equal: key order and every scalar.
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // AC1 — ALL SIX types, not just the two the incident happened to name.
  // ─────────────────────────────────────────────────────────────────────────
  test(
    "every milestone type the server accepts survives the roll, each named individually — plus the " +
      "`release-proposal`, which is a record of its own and not one of the six",
    async () => {
      boot();
      const key = await seedProject("all-types");
      const store = handle!.store;
      const cap = await configureCap(key, FIXTURE_CAP_SMALL);

      const types = await milestoneVocabulary(key);
      const recorded = new Map<string, AnyBody>();
      for (const type of types) {
        const id = await milestone(key, {
          type,
          label: type === "release" ? "9.9.0" : `${type} fixture`,
          commit: `commit-for-${type}`,
          ...(type === "release" ? { crs: [`CR-FIXTURE-LEN${type.length}`] } : {}),
        });
        recorded.set(type, await eventById(id));
      }
      await propose(key, "9.11.0");
      const proposalBefore = (await get(`/api/v2/projects/${key}/release-proposals`)).body;
      expect((proposalBefore.proposals as AnyBody[]).length).toBe(1);

      const rolled = rollWholeBuffer(store, key, cap);
      expectBufferRolled(store, key, cap, rolled);

      const lost: string[] = [];
      for (const [type, before] of recorded) {
        const res = await get(`/api/v2/events/${before.id as string}`);
        if (res.status !== 200) {
          lost.push(`${type} (${before.id as string})`);
          continue;
        }
        expect(res.body.event).toEqual(before);
      }
      expect(lost).toEqual([]);

      // The seventh record kind, on the record side of the same line.
      expect((await get(`/api/v2/projects/${key}/release-proposals`)).body).toEqual(proposalBefore);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // AC1 — `gate` is lifted on the SAME terms, which is strictly more than
  // LIVE_GATE (src/store.ts:3072) exempts today: that predicate protects only
  // a gate that is BOTH unretired AND version-stamped, so a versionless gate
  // and a retired one are prunable right now. Same for a CONSUMED proposal,
  // which LIVE_PROPOSAL (:3079) deliberately stops protecting.
  // ─────────────────────────────────────────────────────────────────────────
  test(
    "a VERSIONLESS gate, a RETIRED gate and a CONSUMED release-proposal survive the roll too — the " +
      "record survives because it is a record, not because an exemption predicate happened to match it",
    async () => {
      boot();
      const key = await seedProject("gate-terms");
      const store = handle!.store;
      const cap = await configureCap(key, FIXTURE_CAP_SMALL);

      await propose(key, "9.9.0");
      const consumedProposal = store.listReleaseProposals(key)[0]!.id;
      const versionlessGate = await gate(key, "gate with no release");
      await milestone(key, {
        type: "release",
        label: "9.9.0",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      });
      // Recorded AFTER the release, so the store retires it on insert.
      const retiredGate = await gate(key, "late gate for 9.9.0", "9.9.0");

      // The fixture really is in the un-exempt state this test is about.
      const retiredBefore = await eventById(retiredGate);
      expect(typeof retiredBefore.retiredAt).toBe("number");
      const versionlessBefore = await eventById(versionlessGate);
      expect(versionlessBefore.version).toBeUndefined();
      const consumedBefore = await eventById(consumedProposal);
      expect(typeof consumedBefore.retiredAt).toBe("number");
      // The consumed proposal is gone from the LIVE read, exactly as designed —
      // it is auditable through the by-id read and nowhere else, which is what
      // makes its eviction silent today.
      expect(
        ((await get(`/api/v2/projects/${key}/release-proposals`)).body.proposals as AnyBody[]).length,
      ).toBe(0);

      const rolled = rollWholeBuffer(store, key, cap);
      expectBufferRolled(store, key, cap, rolled);

      // All three read in ONE comparison, so the diff names every record the
      // sweep took rather than stopping at the first one.
      const after = {
        versionlessGate: await eventRead(versionlessGate),
        retiredGate: await eventRead(retiredGate),
        consumedProposal: await eventRead(consumedProposal),
      };
      expect(after).toEqual({
        versionlessGate: { status: 200, event: versionlessBefore },
        retiredGate: { status: 200, event: retiredBefore },
        consumedProposal: { status: 200, event: consumedBefore },
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // AC4 — equivalence at THIS project's real shape: 4 releases and 45
  // `cr-merged` records, so the proof is at the scale the incident happened
  // at rather than on two rows.
  // ─────────────────────────────────────────────────────────────────────────
  test(
    "at this project's real shape — 4 releases and 45 cr-merged records — GET …/releases, " +
      "GET …/release-proposals, the queue's derived statuses (COMPLETED_UNTRACKED included) and the " +
      "roadmap answer byte-identically before and after the whole buffer rolls",
    async () => {
      boot();
      const key = await seedProject("board-shape");
      const store = handle!.store;
      const cap = await configureCap(key, FIXTURE_CAP_BOARD);

      // 45 merged CRs, split across the four releases this project shipped.
      // Synthetic ids: a test may not ASSERT on a real project's CR namespace
      // (CR-CRU-097 AC7, tests/project-namespace-tripwire.test.ts). The SHAPE
      // is what the fixture needs — 45 distinct ids across four releases — not
      // the ids themselves.
      const merged = Array.from({ length: 45 }, (_, i) => `CR-FIXTURE-A${i + 1}`);
      const labels = ["0.1.0", "0.1.1", "0.1.2", "0.1.3"];
      const shipped: Record<string, string[]> = {
        "0.1.0": merged.slice(0, 20),
        "0.1.1": merged.slice(20, 30),
        "0.1.2": merged.slice(30, 38),
        "0.1.3": merged.slice(38, 45),
      };

      // The queue, seeded through the STORE exactly as the live-board invariant
      // suites seed history (tests/queue-historical-membership.test.ts): these
      // rows have no plan, so their COMPLETED_UNTRACKED status is derived
      // ENTIRELY from the release records' `crs` — the derivation the eviction
      // broke on the live board.
      store.replaceQueue(
        key,
        merged.map((cr) => ({ cr, title: `${cr} work`, wave: "1", dependsOn: [] })),
      );

      for (const label of labels) {
        await propose(key, label);
        await milestone(key, {
          type: "release",
          label,
          commit: `commit-${label}`,
          releasedAt: 1_780_000_000 + labels.indexOf(label) * 86_400,
          crs: shipped[label]!,
        });
      }
      for (const cr of merged) {
        await milestone(key, { type: "cr-merged", label: cr, commit: `merge-${cr}` });
      }
      // One proposal left LIVE, so the proposals read is not trivially empty.
      await propose(key, "0.2.0");

      const snapshot = async (): Promise<AnyBody> => ({
        releases: (await get(`/api/v2/projects/${key}/releases`)).body,
        proposals: (await get(`/api/v2/projects/${key}/release-proposals`)).body,
        // The roadmap strip and the queue read the SAME published answer
        // (src/store.ts:4085-4087 — "every reader … consumes this verbatim").
        queue: (await get(`/api/v2/projects/${key}/queue`)).body,
      });

      const before = await snapshot();
      // The fixture is at the shape the CR names, and the derivation it is
      // about actually fired: 4 releases, 45 rows, every one COMPLETED_UNTRACKED.
      expect((before.releases as AnyBody).releases as AnyBody[]).toHaveLength(4);
      const entriesBefore = (before.queue as AnyBody).entries as AnyBody[];
      expect(entriesBefore).toHaveLength(45);
      expect(entriesBefore.filter((e) => e.status === "COMPLETED_UNTRACKED")).toHaveLength(45);

      const rolled = rollWholeBuffer(store, key, cap);
      expectBufferRolled(store, key, cap, rolled);

      const after = await snapshot();
      expect(after).toEqual(before);
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    },
  );
});
