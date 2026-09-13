// CR-CRU-130 §S2 — a release is a milestone BEFORE and AFTER delivery, not two
// types.
//
// ── What is broken today ──────────────────────────────────────────────────
//
// Proposing `9.9.0` and then shipping `9.9.0` leaves TWO records of TWO types:
// a `release-proposal` row stamped `retired_at` by `stampProposalRetired`
// (src/store.ts:3083) and a separate `release` row inserted beside it. The
// store's own comment already concedes the model it is missing — the release
// "consumes" its proposal because "the release it became now carries the fact"
// — and `retired_at` is standing in for the delivered date the record had no
// column for until CR-CRU-130 §S1 added one.
//
// §S2 collapses the pair: a PROPOSED release is a `release` milestone carrying
// a `targetAt` and no `deliveredAt`; shipping it sets `deliveredAt` on THAT
// record, alongside the commit, the `crs` and the `packages`. One record, two
// points in its life — same id, same label, same declared target.
//
// ── What this file asserts, and how each case fails if nothing is built ────
//
//   1. ONE RECORD, SAME ID. Today the second write INSERTS, so the record
//      count for the label goes 1 -> 2 and the shipped event's id differs from
//      the proposed one's. Both assertions fail on today's build.
//   2. THE TWO READS ARE DERIVED FROM DELIVERY. An UNDELIVERED `release`
//      record is what `listReleaseProposals` answers and what `listReleases`
//      must NOT; today `listReleases` filters on the type name alone, so an
//      undelivered release is served as settled history and the proposals read
//      answers nothing at all.
//   3. `retired_at` STOPS CARRYING DELIVERY. Today shipping stamps it on the
//      proposal row; the assertion that NO record for the label carries
//      `retiredAt` fails. CR-CRU-073's gate retirement — the column's
//      remaining job — is asserted in the same case, because it is the easiest
//      thing to break while removing the other use.
//   4. WAVES. An OUTSTANDING release carries `waves` exactly as a proposal
//      does today; a DELIVERED one does not. This is user-approved design, not
//      a gap (`DN-crucible-wave-track-release.md`: "a wave is a
//      synchronization device, not a delivery bucket"), and the case exists so
//      the next reader cannot mistake the absence for a bug. It fails today
//      because the outstanding half is not reachable through the proposals
//      read at all.
//
// ── Wire shapes are UNCHANGED (§S0) ───────────────────────────────────────
// `GET …/releases` and `GET …/release-proposals` keep their key sets
// byte-identically. They are pinned here as exact key arrays rather than
// spot-checked fields, because "derived from delivery" is only safe if it
// costs the two consumers nothing.
//
// Every store here is `:memory:` or an mkdtemp scratch file, and every server
// is booted on an OS-assigned port. The live data/crucible.db is never opened
// and port 3849 is never touched.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { startServer, type ServerHandle } from "../src/server.ts";
import type { RunEvent } from "../src/types.ts";

const ORCH = "orchestrator-1";

/** Epoch SECONDS, the unit `releasedAt`/`targetAt`/`deliveredAt` already use. */
const TARGET_AT = 1_789_171_200; // 2026-09-11
const SHIPPED_AT = 1_790_000_000;
const DAY = 86_400;

/** The wire key set of one `GET …/release-proposals` member (CR-CRU-091 §S8). */
const PROPOSAL_KEYS = ["label", "targetAt", "timestamp", "waves"];

/** The wire key set of one `GET …/releases` member carrying full provenance
 *  (CR-CRU-074 §S3 + CR-CRU-080 §S4 + CR-CRU-084 §S2). */
const RELEASE_KEYS = ["version", "commit", "releasedAt", "crs", "packages", "timestamp"];

interface ProposalWire {
  label: string;
  targetAt?: number;
  timestamp: number;
  waves: string[];
  [key: string]: unknown;
}

interface ReleaseWire {
  version?: string;
  commit?: string;
  releasedAt?: number;
  crs?: string[];
  packages?: unknown[];
  timestamp: number;
  [key: string]: unknown;
}

interface MilestoneWire {
  id: string;
  type?: string;
  label?: string;
  targetAt?: number;
  deliveredAt?: number;
  retiredAt?: number;
  [key: string]: unknown;
}

interface AnyBody {
  ok: boolean;
  error?: string;
  help?: string[];
  project?: { key: string };
  proposals?: ProposalWire[];
  totalCount?: number;
  releases?: ReleaseWire[];
  milestones?: MilestoneWire[];
  [key: string]: unknown;
}

/**
 * EVERY milestone record the project holds for one label, whatever its type
 * and whether or not it is retired.
 *
 * `listMilestonesByType(key, null)` is CR-CRU-129 §S3's type-agnostic record
 * read, and it deliberately does NOT filter retirement — which is exactly what
 * makes it able to see the second row today's build leaves behind. A read that
 * filtered either would hide the very duplication §S2 exists to remove.
 */
function recordsFor(store: Store, key: string, label: string): RunEvent[] {
  return store.listMilestonesByType(key, null).filter((record) => record.label === label);
}

describe("CR-CRU-130 §S2 — one record, two points in its life", () => {
  function seed(store: Store): string {
    const key = crypto.randomUUID();
    store.addProject({ key, name: "cru130-c2", type: "backend", sutRoot: "/tmp" });
    return key;
  }

  test(
    "proposing 9.9.0 and then shipping it leaves ONE record with the SAME id: the target and " +
      "label survive, the delivery and provenance are added, and no second row appears",
    () => {
      const store = new Store(":memory:");
      const key = seed(store);

      const proposed = store.recordReleaseProposal(key, ORCH, {
        label: "9.9.0",
        targetAt: TARGET_AT,
      }).event;

      // ── PRE-STATE, measured rather than assumed ─────────────────────────
      // Without this, "exactly one record afterwards" would be satisfied by a
      // fixture that wrote nothing at all. The proposal really is held, really
      // is OUTSTANDING, and really is the only record for the label before the
      // ship — so the count below is a claim about the SHIP, not about an
      // empty store.
      const before = recordsFor(store, key, "9.9.0");
      expect(before.length).toBe(1);
      expect(before[0]!.id).toBe(proposed.id);
      expect(before[0]!.targetAt).toBe(TARGET_AT);
      expect(before[0]!.deliveredAt).toBeUndefined();

      const shipped = store.recordMilestoneEvent(key, ORCH, "release", {
        label: "9.9.0",
        commit: "c".repeat(40),
        releasedAt: SHIPPED_AT,
        crs: ["CR-SHIPPED-1", "CR-SHIPPED-2"],
        packages: [{ registry: "npm", name: "@anthill-tec/crucible-server", version: "9.9.0" }],
      }).event;

      // ── ONE RECORD, AND IT IS THE SAME ONE ──────────────────────────────
      const after = recordsFor(store, key, "9.9.0");
      expect(after.length).toBe(1);
      // THE headline: the same id, not merely a record that matches. A build
      // that inserted a second row and retired the first would satisfy every
      // field assertion below and still be the two-record model.
      expect(after[0]!.id).toBe(proposed.id);
      expect(shipped.id).toBe(proposed.id);

      const record = after[0]!;
      expect(record.type).toBe("release");
      expect(record.label).toBe("9.9.0");
      // What it was aimed at survives delivery — the distance between the two
      // dates is the only thing that can say a deliverable slipped.
      expect(record.targetAt).toBe(TARGET_AT);
      expect(record.deliveredAt).toBe(SHIPPED_AT);
      expect(record.releasedAt).toBe(SHIPPED_AT);
      expect(record.commit).toBe("c".repeat(40));
      expect(record.crs).toEqual(["CR-SHIPPED-1", "CR-SHIPPED-2"]);
      expect(record.packages).toEqual([
        { registry: "npm", name: "@anthill-tec/crucible-server", version: "9.9.0" },
      ]);

      // ── AND THE TWO READS MOVED IT, rather than gaining a member ────────
      expect(store.listReleaseProposals(key).map((p) => p.label)).toEqual([]);
      expect(store.listReleases(key).map((r) => r.label)).toEqual(["9.9.0"]);
      expect(store.listReleases(key).map((r) => r.id)).toEqual([proposed.id]);
    },
  );

  test(
    "shipping sets `deliveredAt` and stamps NO `retired_at` on the record, while a GATE for that " +
      "version is still retired by its release (CR-CRU-073)",
    () => {
      const store = new Store(":memory:");
      const key = seed(store);
      const proposed = store.recordReleaseProposal(key, ORCH, {
        label: "9.9.0",
        targetAt: TARGET_AT,
      }).event;
      const untouched = store.recordReleaseProposal(key, ORCH, {
        label: "9.9.1",
        targetAt: TARGET_AT + DAY,
      }).event;
      // A PROPOSAL retires no gate (CR-CRU-091 §S1): this one is live until the
      // release ships, which is what makes the assertion below a claim about
      // the SHIP rather than about the fixture.
      const gate = store.recordGateEvent(key, ORCH, { verdict: "pass" }, { version: "9.9.0" });
      expect(store.getEvent(gate.id)?.retiredAt).toBeUndefined();

      store.recordMilestoneEvent(key, ORCH, "release", {
        label: "9.9.0",
        commit: "d".repeat(40),
        releasedAt: SHIPPED_AT,
      });

      // `retired_at` no longer carries delivery: NO record for the label holds
      // one. Asserted across every record rather than on the id we happen to
      // know, so a build that kept a retired proposal row beside the release
      // fails here even though the release itself is clean.
      const held = recordsFor(store, key, "9.9.0");
      expect(held.length).toBe(1);
      expect(held.map((record) => record.retiredAt)).toEqual([undefined]);
      expect(store.getEvent(proposed.id)?.retiredAt).toBeUndefined();
      // Delivery is said by the date, directly.
      expect(store.getEvent(proposed.id)?.deliveredAt).toBe(SHIPPED_AT);

      // THE COLUMN'S REMAINING JOB, and the easiest thing to break while
      // removing the other one: the release retires its gate.
      expect(typeof store.getEvent(gate.id)?.retiredAt).toBe("number");

      // A release for one label touches no other release's record.
      expect(store.getEvent(untouched.id)?.deliveredAt).toBeUndefined();
      expect(store.getEvent(untouched.id)?.retiredAt).toBeUndefined();
      expect(store.listReleaseProposals(key).map((p) => p.label)).toEqual(["9.9.1"]);
    },
  );

  test(
    "an UNDELIVERED `release` record is what the proposals read answers and what the releases " +
      "read refuses — the two reads are derived from delivery, not from two type names",
    () => {
      const store = new Store(":memory:");
      const key = seed(store);

      // §S2's form, written through the ordinary milestone door: a `release`
      // carrying a target and no delivery. Today this lands in `listReleases`
      // — settled history claiming something that has not shipped — and is
      // invisible to the proposals read.
      const outstanding = store.recordMilestoneEvent(key, ORCH, "release", {
        label: "9.9.0",
        targetAt: TARGET_AT,
      }).event;
      const delivered = store.recordMilestoneEvent(key, ORCH, "release", {
        label: "9.8.0",
        commit: "e".repeat(40),
        releasedAt: SHIPPED_AT,
      }).event;

      expect(store.listReleaseProposals(key).map((p) => p.id)).toEqual([outstanding.id]);
      expect(store.listReleases(key).map((r) => r.id)).toEqual([delivered.id]);
      // NEGATIVE, bounded: exactly one each, so a read that answered every
      // release record whatever its delivery would fail rather than pass on a
      // superset.
      expect(store.listReleaseProposals(key).length).toBe(1);
      expect(store.listReleases(key).length).toBe(1);
      expect(store.listReleases(key).some((r) => r.deliveredAt === undefined)).toBe(false);
      expect(store.listReleaseProposals(key).some((p) => p.deliveredAt !== undefined)).toBe(false);
    },
  );

  test("re-proposing one label still converges to a SINGLE record (§S4b, src/store.ts:2747)", () => {
    const store = new Store(":memory:");
    const key = seed(store);

    const first = store.recordReleaseProposal(key, ORCH, { label: "9.9.0", targetAt: TARGET_AT });
    const same = store.recordReleaseProposal(key, ORCH, { label: "9.9.0", targetAt: TARGET_AT });

    // Identical target: nothing is written and the held record is returned.
    expect(same.changed).toBe(false);
    expect(same.event.id).toBe(first.event.id);
    expect(recordsFor(store, key, "9.9.0").length).toBe(1);

    // A REVISION moves the target. Whatever mechanism records the move, the
    // observable rule is unchanged: ONE live record for the label, carrying
    // the NEW target, and the predecessor still auditable by id.
    const moved = store.recordReleaseProposal(key, ORCH, {
      label: "9.9.0",
      targetAt: TARGET_AT + 30 * DAY,
    });
    expect(moved.changed).toBe(true);

    const live = store.listReleaseProposals(key).filter((p) => p.label === "9.9.0");
    expect(live.length).toBe(1);
    expect(live[0]!.targetAt).toBe(TARGET_AT + 30 * DAY);
    // The fact that the target MOVED is not destroyed: the predecessor keeps
    // the date it declared.
    expect(store.getEvent(first.event.id)?.targetAt).toBe(TARGET_AT);
    // …and a revision is not a delivery.
    expect(store.getEvent(first.event.id)?.deliveredAt).toBeUndefined();
    expect(live[0]!.deliveredAt).toBeUndefined();
  });
});

describe("CR-CRU-130 §S2 — the two reads keep their wire shapes, at this project's real shape", () => {
  const scratchDirs: string[] = [];
  let handle: ServerHandle | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

  function boot(): ServerHandle {
    const dir = mkdtempSync(join(tmpdir(), "cru130-c2-wire-"));
    scratchDirs.push(dir);
    handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
    return handle;
  }

  function base(): string {
    return `http://localhost:${String(handle!.server.port)}`;
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

  async function seedProject(): Promise<string> {
    const created = await post("/api/v2/projects", { name: `cru130-c2-${crypto.randomUUID()}` });
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
    "4 delivered releases and 2 outstanding ones: each read answers exactly its half, with the " +
      "shipped ordering (newest SHIPPED first) and the proposal ordering (VERSION ascending) " +
      "surviving a deliberately scrambled arrival order",
    async () => {
      const server = boot();
      const key = await seedProject();
      const store = server.store;

      // SEEDED OUT OF ORDER, on both axes — arrival order contradicts both the
      // ship dates and the versions, so a read that lost its sort and fell back
      // to arrival order FAILS rather than coincidentally agreeing.
      const shipOrder: Array<[string, number]> = [
        ["0.1.2", SHIPPED_AT + 2 * DAY],
        ["0.1.0", SHIPPED_AT],
        ["0.1.3", SHIPPED_AT + 3 * DAY],
        ["0.1.1", SHIPPED_AT + DAY],
      ];
      for (const [label, releasedAt] of shipOrder) {
        store.recordMilestoneEvent(key, ORCH, "release", {
          label,
          commit: label.replaceAll(".", "").padEnd(40, "f"),
          releasedAt,
          crs: [`CR-SHIPPED-${label}`],
          packages: [{ registry: "npm", name: "@anthill-tec/crucible-server", version: label }],
        });
      }
      // The two OUTSTANDING ones, written through BOTH doors §S2 leaves open,
      // and in DESCENDING version order so the ascending answer is earned:
      //   0.3.0 — the ordinary milestone door, as a `release` with a target;
      //   0.2.0 — the sanctioned `release-propose` route.
      store.recordMilestoneEvent(key, ORCH, "release", {
        label: "0.3.0",
        targetAt: TARGET_AT + 21 * DAY,
      });
      const proposed = await post(`/api/v2/projects/${key}/release-proposals`, {
        agentId: ORCH,
        label: "0.2.0",
        targetAt: TARGET_AT,
      });
      expect(proposed.status).toBe(200);

      // ── THE PROPOSALS READ — the UNDELIVERED releases, version ascending ──
      const proposals = await get(`/api/v2/projects/${key}/release-proposals`);
      expect(proposals.status).toBe(200);
      expect(proposals.body.ok).toBe(true);
      expect((proposals.body.proposals ?? []).map((p) => p.label)).toEqual(["0.2.0", "0.3.0"]);
      expect(proposals.body.totalCount).toBe(2);
      // CR-CRU-091 §S8's shape, member by member, byte-identical.
      for (const proposal of proposals.body.proposals ?? []) {
        expect(Object.keys(proposal).sort()).toEqual([...PROPOSAL_KEYS].sort());
        expect(typeof proposal.targetAt).toBe("number");
        expect(typeof proposal.timestamp).toBe("number");
        expect(Array.isArray(proposal.waves)).toBe(true);
      }
      expect((proposals.body.proposals ?? []).map((p) => p.targetAt)).toEqual([
        TARGET_AT,
        TARGET_AT + 21 * DAY,
      ]);

      // ── THE RELEASES READ — the DELIVERED ones, newest SHIPPED first ─────
      const releases = await get(`/api/v2/projects/${key}/releases`);
      expect(releases.status).toBe(200);
      expect((releases.body.releases ?? []).map((r) => r.version)).toEqual([
        "0.1.3",
        "0.1.2",
        "0.1.1",
        "0.1.0",
      ]);
      // NEGATIVE, and the whole point of "derived from delivery": neither
      // outstanding release leaks into settled history.
      expect((releases.body.releases ?? []).map((r) => r.version)).not.toContain("0.2.0");
      expect((releases.body.releases ?? []).map((r) => r.version)).not.toContain("0.3.0");
      expect((releases.body.releases ?? []).length).toBe(4);
      for (const release of releases.body.releases ?? []) {
        expect(Object.keys(release).sort()).toEqual([...RELEASE_KEYS].sort());
        // A `waves` key on a delivered release would be the scheduling grouping
        // carried forward past its job — §S2 forbids it explicitly.
        expect("waves" in release).toBe(false);
        expect("targetAt" in release).toBe(false);
        expect("deliveredAt" in release).toBe(false);
      }
      expect((releases.body.releases ?? [])[0]!.releasedAt).toBe(SHIPPED_AT + 3 * DAY);
    },
  );

  test(
    "an OUTSTANDING release carries the waves planned into it and IS a release record; a " +
      "DELIVERED one carries no waves and is still ONE record",
    async () => {
      const server = boot();
      const key = await seedProject();

      const proposed = await post(`/api/v2/projects/${key}/release-proposals`, {
        agentId: ORCH,
        label: "0.2.0",
        targetAt: TARGET_AT,
      });
      expect(proposed.status).toBe(200);
      for (const [cr, wave] of [
        ["CR-AUTH-1", 5],
        ["CR-AUTH-2", 6],
      ] as Array<[string, number]>) {
        const planned = await post(`/api/v2/projects/${key}/queue/plan`, {
          agentId: ORCH,
          cr,
          release: "0.2.0",
          wave,
          title: `planned into the outstanding release, wave ${String(wave)}`,
        });
        expect(planned.status).toBe(200);
      }

      // ── HALF ONE: outstanding carries its waves, as a proposal does today ─
      const outstanding = (await get(`/api/v2/projects/${key}/release-proposals`)).body.proposals!;
      expect(outstanding.map((p) => p.label)).toEqual(["0.2.0"]);
      expect(outstanding[0]!.waves).toEqual(["5", "6"]);

      // …and the thing carrying them is a RELEASE record that simply has not
      // been delivered — this is what fails today, where the record is its own
      // `release-proposal` type instead.
      const undelivered = (
        await get(`/api/v2/projects/${key}/milestones?type=release&delivered=false`)
      ).body.milestones!;
      expect(undelivered.map((m) => m.label)).toEqual(["0.2.0"]);
      expect(undelivered[0]!.targetAt).toBe(TARGET_AT);
      expect(undelivered[0]!.deliveredAt).toBeUndefined();
      const recordId = undelivered[0]!.id;

      // ── HALF TWO: delivery does not carry the scheduling grouping forward ─
      server.store.recordMilestoneEvent(key, ORCH, "release", {
        label: "0.2.0",
        commit: "a".repeat(40),
        releasedAt: SHIPPED_AT,
        crs: ["CR-AUTH-1", "CR-AUTH-2"],
      });

      const delivered = (await get(`/api/v2/projects/${key}/releases`)).body.releases!;
      expect(delivered.map((r) => r.version)).toEqual(["0.2.0"]);
      expect("waves" in delivered[0]!).toBe(false);
      // `crs` is the authoritative expression of the bundling, and it survives.
      expect(delivered[0]!.crs).toEqual(["CR-AUTH-1", "CR-AUTH-2"]);

      // ONE record still, and it is the SAME one — the queue rows that named
      // the waves are untouched, they simply stop being published here.
      const records = (await get(`/api/v2/projects/${key}/milestones?type=release`)).body
        .milestones!;
      expect(records.length).toBe(1);
      expect(records[0]!.id).toBe(recordId);
      expect(records[0]!.deliveredAt).toBe(SHIPPED_AT);
      expect(records[0]!.targetAt).toBe(TARGET_AT);
      expect((await get(`/api/v2/projects/${key}/release-proposals`)).body.proposals).toEqual([]);
    },
  );

  // ── A SHIP THAT STATES NO DATE (CR-CRU-130 §S2, GREEN finding) ──────────

  test(
    "a ship that states NO date still ends the label's plan: the gate refuses it, the proposals " +
      "read drops it and the releases read serves it — while `deliveredAt` stays ABSENT rather " +
      "than invented",
    async () => {
      const server = boot();
      const key = await seedProject();

      // THE HOLE THIS CLOSES, measured 2026-09-13 rather than imagined:
      // `scripts/release.sh:733` adds `--released-at` only `if [ -n
      // "$ship_date" ]`, and `release_ship_date` (:405) prints nothing and
      // exits 0 whenever git cannot resolve the sha — a shallow clone or an
      // unfetched tag object. All five clients declare the flag optional, and
      // the route carries it only when well-formed, because CR-CRU-080 §S4
      // deliberately left a dateless release legitimate. So this post is not a
      // hypothetical: it is what the ceremony really sends on that branch.
      const proposed = await post(`/api/v2/projects/${key}/release-proposals`, {
        agentId: ORCH,
        label: "0.4.0",
        targetAt: TARGET_AT,
      });
      expect(proposed.status).toBe(200);
      const planned = server.store.listReleaseProposals(key);
      expect(planned.map((p) => p.label)).toEqual(["0.4.0"]);
      const plannedId = planned[0]!.id;

      const shipped = await post("/api/v2/milestones", {
        projectKey: key,
        agentId: ORCH,
        type: "release",
        label: "0.4.0",
        commit: "a".repeat(40),
        crs: ["CR-SHIPPED-4"],
      });
      expect([200, 201]).toContain(shipped.status);

      // THE LABEL IS NO LONGER A PLAN. Were plan-hood decided by the delivered
      // DATE alone, every assertion in this block would invert: the proposals
      // read would keep publishing a release that has already shipped, and
      // CR-CRU-118's gate would keep admitting new CRs into it.
      expect((await get(`/api/v2/projects/${key}/release-proposals`)).body.proposals).toEqual([]);
      const refused = await post(`/api/v2/projects/${key}/queue/plan`, {
        agentId: ORCH,
        cr: "CR-AUTH-4",
        release: "0.4.0",
        wave: 5,
        title: "planned into a release that shipped without saying when",
      });
      expect(refused.status).toBe(404);
      expect(refused.body.error).toBe(
        `release 0.4.0 has no live proposal — it is not a plannable target`,
      );

      // …and it IS settled history, carrying what it shipped.
      const releases = (await get(`/api/v2/projects/${key}/releases`)).body.releases!;
      expect(releases.map((r) => r.version)).toEqual(["0.4.0"]);
      expect(releases[0]!.crs).toEqual(["CR-SHIPPED-4"]);
      expect("releasedAt" in releases[0]!).toBe(false);

      // NOTHING WAS INVENTED, and this is the half that forbids standing the
      // ingest instant in for a ship date: the record says "it shipped, and
      // when is unknown", which is what is true of it. ONE record still, and
      // the target it declared survives.
      const records = (await get(`/api/v2/projects/${key}/milestones?type=release`)).body
        .milestones!;
      expect(records.length).toBe(1);
      expect(records[0]!.id).toBe(plannedId);
      expect(records[0]!.deliveredAt).toBeUndefined();
      expect(records[0]!.targetAt).toBe(TARGET_AT);
      expect(server.store.listReleases(key).map((r) => r.id)).toEqual([plannedId]);
    },
  );

  test(
    "THE ASYMMETRY, pinned: a release carrying no date at all is SETTLED to the releases read " +
      "and UNDELIVERED to the dates filter — two questions, both answered truthfully of one row",
    async () => {
      const server = boot();
      const key = await seedProject();

      // The pre-CR-CRU-080 shape, which this project really holds: a release
      // recorded with no ship date and no target, because nothing captured one
      // when it landed.
      const legacy = server.store.recordMilestoneEvent(key, ORCH, "release", {
        label: "0.0.9",
        commit: "b".repeat(40),
      }).event;

      // SETTLED: it was never aimed anywhere, so it was never a plan — and
      // dropping it out of `GET …/releases` would be the §S0 wire change a
      // delivery-only split silently makes.
      expect((await get(`/api/v2/projects/${key}/releases`)).body.releases!.map((r) => r.version))
        .toEqual(["0.0.9"]);
      expect((await get(`/api/v2/projects/${key}/release-proposals`)).body.proposals).toEqual([]);

      // UNDELIVERED: it carries no delivered date, which is the only thing the
      // dates filter asks. Both answers are true of this row; the ambiguity is
      // in the DATA, and CR-CRU-130 §S1's read reports the column rather than
      // guessing past it.
      const undelivered = (
        await get(`/api/v2/projects/${key}/milestones?type=release&delivered=false`)
      ).body.milestones!;
      expect(undelivered.map((m) => m.id)).toEqual([legacy.id]);
      const delivered = (await get(`/api/v2/projects/${key}/milestones?type=release&delivered=true`))
        .body.milestones!;
      expect(delivered).toEqual([]);
    },
  );

  // ── THE THIRD CLAUSE OF `RELEASE_IS_A_PLAN`, at the wire ────────────────
  //
  // `delivered_at IS NULL AND target_at IS NOT NULL AND <no provenance>` is a
  // THREE-clause predicate and each clause has to be pinned by something, or
  // the one nothing covers is free to be deleted. The delivery clause and the
  // provenance clauses are pinned by the cases above; the TARGET clause was
  // not, and CR-CRU-130's VERIFY proved it by deleting `target_at IS NOT NULL`
  // and running the whole suite against the mutant: 2468 tests, the same 9
  // failures, not one of them caused by the deletion.
  //
  // These two cases are the ends of that clause. The first is the shape the
  // live store cannot exercise — every release it holds carries a `commit`, so
  // the provenance clause settles them all and the target clause never decides
  // anything. The second is the shape the provenance clauses must NOT settle.

  test(
    "a BARE release — a label and nothing else: no target, no date, no commit, no crs, no " +
      "packages — is SETTLED history and never a live plan, so the gate refuses to plan into it",
    async () => {
      boot();
      const key = await seedProject();

      // The exact payload the shared client builds for `milestone --type
      // release --label 0.0.9` and no other flag — nothing here is a shape
      // only a test can reach.
      const recorded = await post("/api/v2/milestones", {
        projectKey: key,
        agentId: ORCH,
        type: "release",
        label: "0.0.9",
      });
      expect([200, 201]).toContain(recorded.status);

      // NOTHING EVER AIMED IT ANYWHERE, so it was never a plan: a release with
      // no target is history whose ship nobody dated. Drop the target clause
      // and these two invert — the label leaves `GET …/releases` (the §S0 wire
      // change a delivery-only split silently makes) and reappears as a LIVE
      // plan that CR-CRU-118's gate will admit new CRs into.
      expect(
        (await get(`/api/v2/projects/${key}/releases`)).body.releases!.map((r) => r.version),
      ).toEqual(["0.0.9"]);
      expect((await get(`/api/v2/projects/${key}/release-proposals`)).body.proposals).toEqual([]);

      // …and that is the consequence, stated where a reader meets it.
      const refused = await post(`/api/v2/projects/${key}/queue/plan`, {
        agentId: ORCH,
        cr: "CR-AUTH-9",
        release: "0.0.9",
        wave: 1,
        title: "planned into a release that is settled history",
      });
      expect(refused.status).toBe(404);
      expect(refused.body.error).toBe(
        `release 0.0.9 has no live proposal — it is not a plannable target`,
      );
    },
  );

  test(
    "an EMPTY `crs` is the ABSENCE of a shipment fact, not evidence of one: a targeted release " +
      "carrying `crs: []` stays a LIVE plan, and a later empty-handed write does not deliver it",
    async () => {
      const server = boot();
      const key = await seedProject();

      // Reachable only by a raw API caller — every production path avoids it —
      // which is exactly why the predicate has to decide it rather than trust
      // the callers. The route keeps an empty `crs` deliberately (CR-CRU-080
      // §S4: "it says the reporter looked"), so it arrives here intact.
      const planned = await post("/api/v2/milestones", {
        projectKey: key,
        agentId: ORCH,
        type: "release",
        label: "0.7.0",
        targetAt: TARGET_AT,
        crs: [],
      });
      expect([200, 201]).toContain(planned.status);

      // AN EMPTY SET SHIPPED NOTHING. Were the KEY's presence evidence rather
      // than its LENGTH, this release would classify as settled history the
      // moment it was declared and its label would never be plannable.
      const proposals = (await get(`/api/v2/projects/${key}/release-proposals`)).body.proposals!;
      expect(proposals.map((p) => p.label)).toEqual(["0.7.0"]);
      expect(proposals[0]!.targetAt).toBe(TARGET_AT);
      expect((await get(`/api/v2/projects/${key}/releases`)).body.releases).toEqual([]);
      const plannedId = server.store.listReleaseProposals(key)[0]!.id;

      // AND THE WRITE SIDE AGREES ON THE OUTCOME, which is the property that
      // matters — not on the spelling of its predicate. A second empty-handed
      // write for this label MERGES onto the record the first one planned (ONE
      // record, §S2) and that record stays a live plan carrying no delivery,
      // because the read above still refuses to call an empty set evidence.
      // Were the write narrowed to mirror the read literally, this write would
      // fork the label into a second row and put it in BOTH reads at once.
      const empty = await post("/api/v2/milestones", {
        projectKey: key,
        agentId: ORCH,
        type: "release",
        label: "0.7.0",
        crs: [],
      });
      expect([200, 201]).toContain(empty.status);

      expect(recordsFor(server.store, key, "0.7.0").length).toBe(1);
      const stillPlanned = server.store.listReleaseProposals(key);
      expect(stillPlanned.map((p) => p.id)).toEqual([plannedId]);
      expect(stillPlanned[0]!.deliveredAt).toBeUndefined();
      expect((await get(`/api/v2/projects/${key}/releases`)).body.releases).toEqual([]);
      const admitted = await post(`/api/v2/projects/${key}/queue/plan`, {
        agentId: ORCH,
        cr: "CR-AUTH-7",
        release: "0.7.0",
        wave: 1,
        title: "planned into a release that has shipped nothing",
      });
      expect(admitted.status).toBe(200);
    },
  );
});
