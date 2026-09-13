// CR-CRU-129 §S3/AC1 — "each consumer in the §S3 table reads the new tables —
// asserted PER SITE, not as one aggregate 'the reads were updated'".
//
// One test per site, named after the site. The point of the per-site rule is
// that a missed consumer is NAMED by the failure rather than hidden inside an
// aggregate pass: if `deriveCommitBoundary` were the one read left scanning the
// buffer, exactly one test here goes red and its name says which.
//
// ── How each test proves the site reads the RECORD table ──────────────────
//
// Not by looking at SQL. Every test seeds through the ordinary production
// write path, then MEASURES that the capped `events` buffer holds no record row
// at all (`recordsLeftInTheBuffer`), and only then asks the site its question.
// A site still reading `events` therefore answers with nothing, and the
// assertion fails for the right reason. That measurement is the non-vacuity
// guard for the whole file and runs in every test.
//
// ── Where the rest of the table is ────────────────────────────────────────
//
//   `GET …/releases`, `GET …/release-proposals`, the pane feed and
//   `GET …/events/<id>`   -> tests/events-feed-after-records-moved.test.ts
//                            (wire reads belong in the wire file)
//   `cr_merged_crs` + `cmd_queue`
//                         -> tests/client/test_queue_reads_merged_crs_by_type.py
//                            (the one CLIENT read §S3 changes)
//
// ── Safety ────────────────────────────────────────────────────────────────
// Every store here is `:memory:`. The live `data/crucible.db` is never opened,
// copied or migrated. Fixture cr ids are drawn from the REGISTERED synthetic
// namespaces the project-namespace tripwire allows (`CR-SHIPPED-*` for rows a
// release names, `CR-AUTH-*` for the authored-but-unplanned row beside them) —
// never a real board id.
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Store } from "../src/store.ts";
import type { Plan, QueueEntry, RunEvent } from "../src/types.ts";

const AGENT = "cr129-c2-sites";

function seedProject(store: Store): string {
  const key = crypto.randomUUID();
  store.addProject({ key, name: "cru129-sites", type: "backend", sutRoot: "/tmp" });
  return key;
}

/**
 * The premise, MEASURED in every test below: after §S1 the capped buffer holds
 * no milestone and no gate row, so a read still pointed at `events` answers
 * with nothing.
 */
function recordsLeftInTheBuffer(store: Store, key: string): number {
  return (store as unknown as { db: Database }).db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events
        WHERE project_key = ? AND kind IN ('milestone', 'gate')`,
    )
    .get(key)!.n;
}

function planned<T extends object>(result: T): Exclude<T, { error: string }> {
  if ("error" in result) throw new Error(`plan op refused: ${String(result.error)}`);
  return result as Exclude<T, { error: string }>;
}

function entryFor(queue: QueueEntry[], cr: string): QueueEntry {
  const found = queue.find((row) => row.cr === cr);
  if (found === undefined) throw new Error(`no queue entry for ${cr}`);
  return found;
}

describe("CR-CRU-129 §S3/AC1 — every read in the consumer table, one site at a time", () => {
  test("§S3 site — `listReleases` answers from the record table, newest SHIPPED first", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    store.recordMilestoneEvent(key, AGENT, "release", {
      label: "0.1.2",
      commit: "aaa1111",
      releasedAt: 1_700_000_000,
      crs: ["CR-SHIPPED-1"],
    });
    store.recordMilestoneEvent(key, AGENT, "release", {
      label: "0.1.3",
      commit: "bbb2222",
      releasedAt: 1_700_100_000,
      crs: ["CR-SHIPPED-2", "CR-SHIPPED-3"],
    });
    expect(recordsLeftInTheBuffer(store, key)).toBe(0);

    const releases = store.listReleases(key);

    expect(releases.map((release) => release.label)).toEqual(["0.1.3", "0.1.2"]);
    // The `crs` set is what queue membership is derived from, so it is asserted
    // byte-for-byte rather than by length.
    expect(releases[0]!.crs).toEqual(["CR-SHIPPED-2", "CR-SHIPPED-3"]);
    expect(releases[1]!.crs).toEqual(["CR-SHIPPED-1"]);
  });

  test("§S3 site — `listReleaseProposals` answers from the record table, LIVE only, version-ordered", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    store.recordReleaseProposal(key, AGENT, { label: "0.3.0", targetAt: 1_800_000_000 });
    store.recordReleaseProposal(key, AGENT, { label: "0.2.1", targetAt: 1_790_000_000 });
    expect(recordsLeftInTheBuffer(store, key)).toBe(0);

    expect(store.listReleaseProposals(key).map((row) => row.label)).toEqual(["0.2.1", "0.3.0"]);

    // Shipping 0.2.1 CONSUMES its proposal — the retirement is a column on the
    // record table now, so a read of the old buffer would never see it change.
    store.recordMilestoneEvent(key, AGENT, "release", { label: "0.2.1", commit: "ccc3333" });

    expect(store.listReleaseProposals(key).map((row) => row.label)).toEqual(["0.3.0"]);
  });

  test("§S3 site — the queue status derivation reads a release's `crs` from the record table", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    store.replaceQueue(key, [
      { cr: "CR-SHIPPED-3", wave: "6", dependsOn: [] },
      { cr: "CR-AUTH-1", wave: "6", dependsOn: [] },
    ]);
    // Neither cr has a plan, so the ONLY thing that can lift one out of PENDING
    // is a release record naming it.
    expect(entryFor(store.listQueue(key), "CR-SHIPPED-3").status).toBe("PENDING");

    store.recordMilestoneEvent(key, AGENT, "release", {
      label: "0.1.3",
      commit: "ddd4444",
      crs: ["CR-SHIPPED-3"],
    });
    expect(recordsLeftInTheBuffer(store, key)).toBe(0);

    const queue = store.listQueue(key);

    expect(entryFor(queue, "CR-SHIPPED-3").status).toBe("COMPLETED_UNTRACKED");
    // NEGATIVE, and the reason the pair is seeded: the derivation moved the cr
    // the release names and NOT the one it does not.
    expect(entryFor(queue, "CR-AUTH-1").status).toBe("PENDING");
  });

  test("§S3 site — `repairReleaseProvenance` finds and rewrites the held release in the record table", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    const first = store.recordMilestoneEvent(key, AGENT, "release", {
      label: "0.1.0",
      commit: "eee5555",
      crs: ["CR-SHIPPED-6"],
    });
    expect(recordsLeftInTheBuffer(store, key)).toBe(0);

    const repaired = store.recordMilestoneEvent(key, AGENT, "release", {
      label: "0.1.0",
      commit: "eee5555",
      crs: ["CR-SHIPPED-6", "CR-SHIPPED-7", "CR-SHIPPED-8"],
      repairProvenance: true,
    });

    // SAME row — the repair path keeps the release's identity; it does not
    // append a second one, which is what a read that missed the held record
    // would do.
    expect(repaired.event.id).toBe(first.event.id);
    expect(repaired.changed).toBe(true);
    expect(store.listReleases(key).length).toBe(1);
    expect(store.listReleases(key)[0]!.crs).toEqual([
      "CR-SHIPPED-6",
      "CR-SHIPPED-7",
      "CR-SHIPPED-8",
    ]);
  });

  test("§S3 site — the gate reads: a release retires its gates where the gates now live", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    const gated = store.recordGateEvent(key, AGENT, { status: "pass" }, { version: "0.1.3" });
    const other = store.recordGateEvent(key, AGENT, { status: "pass" }, { version: "0.2.0" });
    expect(recordsLeftInTheBuffer(store, key)).toBe(0);
    expect(store.getEvent(gated.id)!.retiredAt).toBeUndefined();

    store.recordMilestoneEvent(key, AGENT, "release", { label: "0.1.3", commit: "fff6666" });

    expect(typeof store.getEvent(gated.id)!.retiredAt).toBe("number");
    // BOUNDED: the stamp is scoped by version, so the 0.2.0 gate is untouched.
    // A retirement that swept every gate would pass the line above and fail
    // this one.
    expect(store.getEvent(other.id)!.retiredAt).toBeUndefined();
  });

  test("§S3 site — `deriveCommitBoundary` reads a GATE's context from the record table", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    const plan: Plan = planned(
      store.filePlan(key, { cr: "CR-BOUNDARY-GATE", cycles: [{ label: "c1", kind: "red-green" }] }),
    );
    const cycleId = plan.cycles[0]!.id;

    // The ONLY context-bearing row in this project is a GATE — no test event at
    // all — so the branch and commit below can have reached the boundary from
    // nowhere else.
    store.recordGateEvent(
      key,
      AGENT,
      { status: "pass" },
      { context: { cycleId, git: { branch: "feat/records", commit: "c1a2b3c" } } },
    );
    expect(recordsLeftInTheBuffer(store, key)).toBe(0);

    planned(store.transitionCycle(key, plan.planId, cycleId, "active"));
    planned(store.transitionCycle(key, plan.planId, cycleId, "done"));
    planned(store.closePlan(key, plan.planId, { commit: "abc1234" }));

    const boundary = store.listPlans(key).find((row) => row.cr === "CR-BOUNDARY-GATE")!
      .commitBoundary;

    expect(boundary).toBeDefined();
    expect(boundary!.mergeCommit).toBe("abc1234");
    expect(boundary!.branch).toBe("feat/records");
    expect(boundary!.firstRunCommit).toBe("c1a2b3c");
    expect(boundary!.lastRunCommit).toBe("c1a2b3c");
  });

  test("§S3 site — `getEvent` is the audit read for a moved record, including the rows no live list serves", () => {
    const store = new Store(":memory:");
    const key = seedProject(store);
    const merged: RunEvent = store.recordMilestoneEvent(key, AGENT, "cr-merged", {
      label: "CR-SHIPPED-9",
    }).event;
    const proposal: RunEvent = store.recordReleaseProposal(key, AGENT, {
      label: "0.1.3",
      targetAt: 1_800_000_000,
    }).event;
    const gate = store.recordGateEvent(key, AGENT, { status: "pass" }, { version: "0.1.3" });

    // Shipping 0.1.3 consumes the proposal AND retires the gate: after this,
    // neither is served by any live list, and `getEvent` is the only read that
    // can still answer for them.
    store.recordMilestoneEvent(key, AGENT, "release", { label: "0.1.3", commit: "fff6666" });
    expect(recordsLeftInTheBuffer(store, key)).toBe(0);
    expect(store.listReleaseProposals(key)).toEqual([]);

    expect(store.getEvent(merged.id)!.label).toBe("CR-SHIPPED-9");
    expect(store.getEvent(merged.id)!.kind).toBe("milestone");
    expect(store.getEvent(proposal.id)!.type).toBe("release-proposal");
    expect(store.getEvent(proposal.id)!.targetAt).toBe(1_800_000_000);
    expect(store.getEvent(gate.id)!.kind).toBe("gate");
    expect(typeof store.getEvent(gate.id)!.retiredAt).toBe("number");
    // The by-id read did not become "return something for anything".
    expect(store.getEvent("evt-1700000000000-9999")).toBeNull();
  });
});
