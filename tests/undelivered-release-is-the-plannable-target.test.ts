// CR-CRU-130 §S4b — the consumers of "a live proposal", one case each.
//
// §S2 retires `release-proposal` as a type, so every place that reasons about a
// LIVE proposal now reasons about an UNDELIVERED release. The CR ENUMERATES
// those places because an unenumerated one inverts silently — and two of them
// decide whether a CR can be planned at all. Each row of that table gets its
// OWN case here, never an aggregate pass, so a report can name which consumer
// broke rather than that "the §S4b test" is red.
//
// | consumer                          | site              | case below |
// |-----------------------------------|-------------------|------------|
// | CR-CRU-118's plannable-target gate| src/v2.ts:2837    | 1 (both directions) |
// | the shipped-is-settled refusal    | src/hints.ts:404  | 2 |
// | three `release-proposals` lines   | src/hints.ts:382/398/403 | 3 |
// | proposal convergence              | src/store.ts:2884 | 4 |
// | `stampProposalRetired`, site 2    | src/store.ts:2905 | 5 |
// | `listReleaseProposals`/`listReleases` | src/store.ts:3424/3382 | 6 |
//
// (`stampProposalRetired` site 1 — retirement-on-ship — is case 2 of
// tests/release-before-and-after-delivery.test.ts, where the `deliveredAt` it
// becomes and the gate job it keeps are asserted together.)
//
// ── How each case fails if the code does nothing ──────────────────────────
//
//   1 ACCEPT — an undelivered `release` record is not a "live proposal" to
//     today's gate, so `cr-plan` answers 404 and no queue row is written.
//     REFUSE — a GREEN GUARD: it must keep refusing, byte-identically, and a
//     gate rewritten to resolve from delivery is exactly the change that could
//     accidentally admit everything. A one-sided test would not notice.
//   2 GREEN GUARD — a delivered release must stay settled history. Asserted
//     because §S2 moves the case from "its proposal was consumed" to "it has a
//     `deliveredAt`", which is a different derivation reaching the same answer.
//   3 The three sentences are GREEN GUARDS, pinned as literals. The fourth
//     assertion — that the route they name answers with the UNDELIVERED
//     release — fails today, because the record it must publish is a
//     `release-proposal` and not a release at all.
//   4/5/6 fail today wherever they ask what the surviving record IS: today it
//     is a `release-proposal` row, so `?type=release&delivered=false` answers
//     nothing.
//
// Every server is booted on an OS-assigned port against an mkdtemp scratch db.
// The live data/crucible.db is never opened and port 3849 is never touched.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";

const ORCH = "orchestrator-1";
const TARGET_AT = 1_789_171_200;
const SHIPPED_AT = 1_790_000_000;
const DAY = 86_400;

/**
 * THE REFUSAL, BYTE-IDENTICAL (§S4b, src/v2.ts:2837 + src/hints.ts:401-405).
 *
 * Written as LITERALS rather than imported from `src/hints.ts`: importing the
 * subject and comparing it with itself asserts nothing, and "byte-identical"
 * is a claim about the words a human reads in a terminal. If GREEN changes a
 * character of them, this file is where it must be argued.
 */
const UNPROPOSED_SENTENCE = (label: string): string =>
  `release ${label} has no live proposal — it is not a plannable target`;

const UNPROPOSED_HELP = (label: string): string[] => [
  `release-propose --label ${label} — the super container must exist before a CR can target it`,
  `GET /api/v2/projects/<key>/release-proposals — the live proposals a CR can be planned into`,
  `a release that has already SHIPPED is settled history and is no longer a plannable target for ${label}`,
];

/** src/hints.ts:382 — `missingRelease`'s route line. */
const PROPOSALS_LINE_MISSING_RELEASE =
  `GET /api/v2/projects/<key>/release-proposals — the live proposals a CR can be planned into`;

/** src/hints.ts:398 — `missingTarget`'s route line. */
const PROPOSALS_LINE_MISSING_TARGET =
  `GET /api/v2/projects/<key>/release-proposals — the live proposals and the targets they already declared`;

/** src/hints.ts:403 — `unproposedRelease`'s route line. Shared VERBATIM with
 *  :382 by design — one question, one route named. */
const PROPOSALS_LINE_UNPROPOSED = PROPOSALS_LINE_MISSING_RELEASE;

interface QueueEntryWire {
  cr: string;
  release?: string;
  wave: string;
  [key: string]: unknown;
}

interface MilestoneWire {
  id: string;
  type?: string;
  label?: string;
  targetAt?: number;
  deliveredAt?: number;
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
  proposals?: Array<{ label: string; targetAt?: number; timestamp: number; waves: string[] }>;
  totalCount?: number;
  releases?: Array<{ version?: string; releasedAt?: number; [key: string]: unknown }>;
  milestones?: MilestoneWire[];
  [key: string]: unknown;
}

describe("CR-CRU-130 §S4b — every consumer of 'a live proposal' now reads an UNDELIVERED release", () => {
  const scratchDirs: string[] = [];
  let handle: ServerHandle | undefined;

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
  });

  function boot(): ServerHandle {
    const dir = mkdtempSync(join(tmpdir(), "cru130-c2-s4b-"));
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
    const created = await post("/api/v2/projects", { name: `cru130-s4b-${crypto.randomUUID()}` });
    const key = created.body.project!.key;
    const registered = await post("/api/v2/agents/register", {
      projectKey: key,
      agentId: ORCH,
      role: "ORCHESTRATOR",
    });
    expect(registered.status).toBe(200);
    return key;
  }

  function planPath(key: string): string {
    return `/api/v2/projects/${key}/queue/plan`;
  }

  function proposalsPath(key: string): string {
    return `/api/v2/projects/${key}/release-proposals`;
  }

  /** §S2's form of an OUTSTANDING release, written through the ordinary
   *  milestone door: a `release` carrying a target and no delivery. */
  function recordOutstandingRelease(server: ServerHandle, key: string, label: string, at: number) {
    return server.store.recordMilestoneEvent(key, ORCH, "release", { label, targetAt: at }).event;
  }

  // ── 1. CR-CRU-118's plannable-target gate — BOTH directions ─────────────

  test(
    "consumer 1 (src/v2.ts:2837) — `cr-plan` REFUSES a release with no undelivered record, with " +
      "its sentence and help[] byte-identical",
    async () => {
      boot();
      const key = await seedProject();
      // NON-VACUITY: the project holds a real, undelivered release under a
      // DIFFERENT label, so the refusal below is about THIS label rather than
      // about a board with nothing on it — a gate that refused everything
      // would still pass a test run against an empty project.
      recordOutstandingRelease(handle!, key, "0.2.0", TARGET_AT);

      const refused = await post(planPath(key), {
        agentId: ORCH,
        cr: "CR-AUTH-7",
        release: "0.9.0",
        wave: 5,
        title: "planned into a release nobody proposed",
      });

      expect(refused.status).toBe(404);
      expect(refused.body.error).toBe(UNPROPOSED_SENTENCE("0.9.0"));
      expect(refused.body.help).toEqual(UNPROPOSED_HELP("0.9.0"));
      // NOTHING was written: the refusal is not a warning.
      const queue = await get(`/api/v2/projects/${key}/queue`);
      expect((queue.body.entries ?? []).map((entry) => entry.cr)).not.toContain("CR-AUTH-7");
    },
  );

  test(
    "consumer 1 (src/v2.ts:2837), the other direction — `cr-plan` ACCEPTS a CR planned into a " +
      "release that is UNDELIVERED, and the row it writes names that release",
    async () => {
      const server = boot();
      const key = await seedProject();
      const outstanding = recordOutstandingRelease(server, key, "0.2.0", TARGET_AT);

      const planned = await post(planPath(key), {
        agentId: ORCH,
        cr: "CR-AUTH-8",
        release: "0.2.0",
        wave: 5,
        title: "planned into an undelivered release",
      });

      expect(planned.status).toBe(200);
      expect(planned.body.ok).toBe(true);
      expect(planned.body.error).toBeUndefined();
      expect(planned.body.entry?.release).toBe("0.2.0");
      expect(planned.body.entry?.cr).toBe("CR-AUTH-8");
      // The row is really in the queue, declared against that release.
      const queue = await get(`/api/v2/projects/${key}/queue`);
      const row = (queue.body.entries ?? []).find((entry) => entry.cr === "CR-AUTH-8");
      expect(row?.release).toBe("0.2.0");
      // …and the target it was planned into is the record the gate resolved
      // from — still undelivered, still carrying its declared date.
      const record = (await get(`/api/v2/projects/${key}/milestones?type=release&delivered=false`))
        .body.milestones;
      expect((record ?? []).map((m) => m.id)).toEqual([outstanding.id]);
      expect((record ?? [])[0]?.targetAt).toBe(TARGET_AT);
    },
  );

  // ── 2. the shipped-is-settled refusal (src/hints.ts:404) ────────────────

  test(
    "consumer 2 (src/hints.ts:404) — a DELIVERED release is refused as a plannable target, " +
      "carrying the settled-history sentence",
    async () => {
      const server = boot();
      const key = await seedProject();
      // Proposed, then SHIPPED — the full life of the record §S2 unifies.
      server.store.recordReleaseProposal(key, ORCH, { label: "0.1.0", targetAt: TARGET_AT });
      server.store.recordMilestoneEvent(key, ORCH, "release", {
        label: "0.1.0",
        commit: "b".repeat(40),
        releasedAt: SHIPPED_AT,
        crs: ["CR-SHIPPED-1"],
      });

      const refused = await post(planPath(key), {
        agentId: ORCH,
        cr: "CR-AUTH-9",
        release: "0.1.0",
        wave: 5,
        title: "planned into settled history",
      });

      expect(refused.status).toBe(404);
      expect(refused.body.error).toBe(UNPROPOSED_SENTENCE("0.1.0"));
      expect(refused.body.help).toEqual(UNPROPOSED_HELP("0.1.0"));
      expect(refused.body.help?.[2]).toBe(
        `a release that has already SHIPPED is settled history and is no longer a plannable target for 0.1.0`,
      );
      // The release really IS delivered — so the refusal is the DELIVERED case
      // and not an accident of the label being unknown.
      const delivered = (await get(`/api/v2/projects/${key}/milestones?type=release&delivered=true`))
        .body.milestones;
      expect((delivered ?? []).map((m) => m.label)).toEqual(["0.1.0"]);
      expect((delivered ?? [])[0]?.deliveredAt).toBe(SHIPPED_AT);
      // CR-CRU-118 §S3a's one door is untouched: the release's OWN cr is still
      // admissible, so this refusal has not widened into "nothing may name a
      // shipped release".
      const claimed = await post(planPath(key), {
        agentId: ORCH,
        cr: "CR-SHIPPED-1",
        release: "0.1.0",
        wave: 5,
        title: "the release's own cr",
      });
      expect(claimed.status).toBe(200);
    },
  );

  // ── 3. the three `release-proposals` route sentences ────────────────────

  test(
    "consumer 3 (src/hints.ts:382/398/403) — the three `release-proposals` sentences are " +
      "unchanged, and the route they name still answers with the UNDELIVERED release",
    async () => {
      const server = boot();
      const key = await seedProject();
      const outstanding = recordOutstandingRelease(server, key, "0.2.0", TARGET_AT);

      // :382 — a declaration carrying NO release at all.
      const noRelease = await post(planPath(key), {
        agentId: ORCH,
        cr: "CR-AUTH-10",
        wave: 5,
        title: "no release named",
      });
      expect(noRelease.status).toBe(400);
      expect(noRelease.body.help?.[0]).toBe(PROPOSALS_LINE_MISSING_RELEASE);

      // :398 — a `release-propose` carrying NO `targetAt`.
      const noTarget = await post(proposalsPath(key), { agentId: ORCH, label: "0.4.0" });
      expect(noTarget.status).toBe(400);
      expect(noTarget.body.help?.[2]).toBe(PROPOSALS_LINE_MISSING_TARGET);

      // :403 — a cr planned into a label with no undelivered record.
      const unproposed = await post(planPath(key), {
        agentId: ORCH,
        cr: "CR-AUTH-11",
        release: "0.9.9",
        wave: 5,
        title: "unproposed",
      });
      expect(unproposed.status).toBe(404);
      expect(unproposed.body.help?.[1]).toBe(PROPOSALS_LINE_UNPROPOSED);

      // AND THE ROUTE THEY NAME KEEPS ANSWERING — with the undelivered
      // release, which is the record that has taken the proposal's place.
      const answered = await get(proposalsPath(key));
      expect(answered.status).toBe(200);
      expect(answered.body.ok).toBe(true);
      expect((answered.body.proposals ?? []).map((p) => p.label)).toEqual(["0.2.0"]);
      expect((answered.body.proposals ?? [])[0]?.targetAt).toBe(TARGET_AT);
      expect(answered.body.totalCount).toBe(1);
      // The thing it published is the record the milestone door wrote.
      const records = (await get(`/api/v2/projects/${key}/milestones?type=release`)).body.milestones;
      expect((records ?? []).map((m) => m.id)).toEqual([outstanding.id]);
      // …and no `release-proposal` record was created behind it.
      const legacy = (await get(`/api/v2/projects/${key}/milestones?type=release-proposal`)).body
        .milestones;
      expect(legacy).toEqual([]);
    },
  );

  // ── 4. proposal convergence (src/store.ts:2884) ─────────────────────────

  test(
    "consumer 4 (src/store.ts:2884) — re-proposing one label through the route converges to a " +
      "SINGLE undelivered release record rather than adding a row",
    async () => {
      boot();
      const key = await seedProject();

      const first = await post(proposalsPath(key), {
        agentId: ORCH,
        label: "0.2.0",
        targetAt: TARGET_AT,
      });
      expect(first.status).toBe(200);
      expect(first.body.converged).toBe(false);

      const again = await post(proposalsPath(key), {
        agentId: ORCH,
        label: "0.2.0",
        targetAt: TARGET_AT,
      });
      expect(again.status).toBe(200);
      expect(again.body.converged).toBe(true);

      // ONE record for the label, and it is an UNDELIVERED RELEASE — the thing
      // that fails today, where the converged record is a `release-proposal`.
      const records = (await get(`/api/v2/projects/${key}/milestones?type=release`)).body
        .milestones!;
      expect(records.filter((m) => m.label === "0.2.0").length).toBe(1);
      expect(records[0]!.deliveredAt).toBeUndefined();
      expect(records[0]!.targetAt).toBe(TARGET_AT);
      expect((await get(proposalsPath(key))).body.totalCount).toBe(1);
    },
  );

  // ── 5. `stampProposalRetired`, the REVISION call site ───────────────────

  test(
    "consumer 5 (src/store.ts:2905) — a REVISION leaves exactly one undelivered release carrying " +
      "the new target, and the superseded date stays auditable",
    async () => {
      const server = boot();
      const key = await seedProject();

      const first = await post(proposalsPath(key), {
        agentId: ORCH,
        label: "0.2.0",
        targetAt: TARGET_AT,
      });
      expect(first.status).toBe(200);

      const revised = await post(proposalsPath(key), {
        agentId: ORCH,
        label: "0.2.0",
        targetAt: TARGET_AT + 30 * DAY,
      });
      expect(revised.status).toBe(200);
      expect(revised.body.converged).toBe(false);

      // ONE live answer, carrying the MOVED target.
      const live = (await get(proposalsPath(key))).body.proposals!;
      expect(live.map((p) => p.label)).toEqual(["0.2.0"]);
      expect(live[0]!.targetAt).toBe(TARGET_AT + 30 * DAY);

      // …and it is an UNDELIVERED RELEASE record, exactly one of them.
      const undelivered = (
        await get(`/api/v2/projects/${key}/milestones?type=release&delivered=false`)
      ).body.milestones!;
      expect(undelivered.length).toBe(1);
      expect(undelivered[0]!.targetAt).toBe(TARGET_AT + 30 * DAY);

      // ── THE TWO READS, PINNED AS A PAIR (CR-CRU-130 §S2) ──────────────
      // The dated read above answers the LIVE record only — a superseded plan
      // is not something outstanding. The UNFILTERED read is the audit read
      // and answers BOTH, which is the half that would otherwise be unpinned:
      // a build that dropped the coupling would serve the predecessor as
      // outstanding and this case's `length` above would catch it, while a
      // build that filtered retirement everywhere would lose the audit and
      // nothing would catch it at all.
      const audited = (await get(`/api/v2/projects/${key}/milestones?type=release`)).body
        .milestones!;
      expect(audited.length).toBe(2);
      const superseded = audited.filter((m) => m.id !== undelivered[0]!.id);
      expect(superseded.length).toBe(1);
      // …and the PREDECESSOR KEEPS THE OLD TARGET. The clause that catches a
      // build which keeps both rows and revises the target in place: the fact
      // that the date MOVED is precisely what a slipping plan leaves behind,
      // and an in-place edit destroys it while satisfying every count here.
      expect(superseded[0]!.targetAt).toBe(TARGET_AT);
      expect(superseded[0]!.deliveredAt).toBeUndefined();

      // A revision is NOT a delivery: nothing for this label reads as met.
      const delivered = (await get(`/api/v2/projects/${key}/milestones?type=release&delivered=true`))
        .body.milestones!;
      expect(delivered).toEqual([]);
      expect((await get(`/api/v2/projects/${key}/releases`)).body.releases).toEqual([]);
    },
  );

  // ── 6. `listReleaseProposals` / `listReleases` ──────────────────────────

  test(
    "consumer 6 (src/store.ts:3424/3382) — one label MOVES from the proposals read to the " +
      "releases read when it is delivered, and is never in both or in neither",
    async () => {
      const server = boot();
      const key = await seedProject();
      recordOutstandingRelease(server, key, "0.2.0", TARGET_AT);

      const outstanding = await get(proposalsPath(key));
      expect((outstanding.body.proposals ?? []).map((p) => p.label)).toEqual(["0.2.0"]);
      expect(outstanding.body.totalCount).toBe(1);
      expect((await get(`/api/v2/projects/${key}/releases`)).body.releases).toEqual([]);

      server.store.recordMilestoneEvent(key, ORCH, "release", {
        label: "0.2.0",
        commit: "f".repeat(40),
        releasedAt: SHIPPED_AT,
        crs: ["CR-SHIPPED-2"],
      });

      const settled = await get(`/api/v2/projects/${key}/releases`);
      expect((settled.body.releases ?? []).map((r) => r.version)).toEqual(["0.2.0"]);
      expect((settled.body.releases ?? [])[0]?.releasedAt).toBe(SHIPPED_AT);
      const afterwards = await get(proposalsPath(key));
      expect(afterwards.body.proposals).toEqual([]);
      expect(afterwards.body.totalCount).toBe(0);
    },
  );
});
