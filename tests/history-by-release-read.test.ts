// CR-CRU-173 §S2 — the history read: GET /api/v2/projects/<key>/history.
// Cycle 636 (RED). This cycle owns the SERVER READ only — the History page
// (§S1) is the next cycle, and the AC3 real-dev-store-copy check is VERIFY's.
//
// ── What this route answers (from docs/changes/CR-CRU-173-history-is-told-by-release.md) ──
//
//   Which releases: every release record that HAS HISTORY — shipped, or
//   holding a merged CR, a plan or a gate. A release declaring only a target
//   and holding none of those (0.4.0 in the spec's own example) is future
//   work, not history, and is excluded.
//   A shipped release's record `crs` wins over the queue's `release` field;
//   an unshipped release takes its CRs from the queue's `release`; a CR two
//   releases both name appears under BOTH, honestly.
//   One row per release (user ruling 2026-10-08): releases shipped the same
//   day are separate rows, each with its own CRs and waves.
//   A release's waves are latest-first, each carrying only that release's
//   own CR ids; a wave split across releases appears under each.
//   Gate runs: grouped by `runId` when snapshots carry one, otherwise
//   seal-bounded (every snapshot up to and including the next gate not in
//   flight); outcome is the seal's, stop step is the first step not
//   passed/skipped, fix rounds the times a step entered `fixing`, duration
//   first snapshot -> seal. RETIRED gates ARE returned here — the one read
//   that returns them. A gate naming no release belongs to the release of
//   the wave it gated (its snapshots' `context.wave`); one naming neither
//   belongs to the first release that shipped at or after it, else the
//   lowest unshipped release (user ruling 2026-10-08).
//   Verification is the count of runs filed under the release (CR-CRU-164).
//
// ── Decisions this file makes, binding for GREEN (the spec leaves the wire
//    shape open; this is RED's call, stated here rather than guessed at) ───
//
//   Route: GET /api/v2/projects/<key>/history. Envelope: {ok:true,
//   releases: HistoryRelease[]} — the SAME `releases` key
//   GET …/releases already uses. Unknown project -> 404 `unknown project:
//   <key>`, exactly `handleProjectReleases`'s own pattern (checked below by
//   reading src/v2.ts directly).
//
//   HistoryRelease = {
//     labels: string[]            // always exactly one label (one row per release)
//     state: "shipped" | "in progress" | "ship not recorded"
//     shippedAt?: number          // epoch SECONDS, present iff shipped
//     tag?: string                // "v<label>", present iff shipped
//     commit?: string             // present iff shipped
//     targetAt?: number           // epoch SECONDS, present iff a target is declared
//     crCount: number             // the release's own CRs
//     waves: { wave: string; crs: string[] }[]   // latest-first
//     workflows: {                // exactly one entry: the release's own workflow
//       label: string;
//       gateRuns: HistoryGateRun[];
//       verificationRuns: number;
//       packages?: PackageRef[];
//     }[]
//   }
//   HistoryGateRun = {
//     runId?: string; outcome: string; stopStep?: string; fixRounds: number;
//     durationMs: number; pushedCommit?: string; eventId: string;
//     retired: boolean; decisionSummary?: DecisionSummaryWire;
//   }
//
//   "in progress" vs "ship not recorded" (the spec names both strings but
//   does not define the boundary; F22 — which wins on disagreement — draws
//   it visually: 0.3.0, still merging CRs, reads "in progress"; 0.2.2, whose
//   CRs are ALL merged but never shipped, reads "ship not recorded"). This
//   file's rule, stated once here: an unshipped release reads "in progress"
//   while at least one of its CRs has no closed+merged plan, and "ship not
//   recorded" once every one of its CRs does.
//
// This file drives the REAL production server (startServer). GET …/history
// matches no branch in handleV2 (verified by reading src/v2.ts directly —
// only /releases, /release-proposals, /queue, /milestones, /plans sit under
// /projects/<key>/), so it falls through to the catch-all 404 today, which
// carries neither `ok:false` nor an `unknown project` message — every
// assertion below fails against production as it stands, not from a typo.
import { describe, test, expect, afterEach, beforeAll, afterAll, setSystemTime } from "bun:test";
import { Store } from "../src/store.ts";
import { startServer, type ServerHandle } from "../src/server.ts";

// ── wire shapes this file expects back ──────────────────────────────────────

interface PackageRefWire {
  registry: string;
  name: string;
  version: string;
}

interface DecisionSummaryWire {
  decisions: number;
  fixed: number;
  added: number;
  declined: number;
  approvedWithReason: number;
}

interface HistoryGateRunWire {
  runId?: string;
  outcome: string;
  stopStep?: string;
  fixRounds: number;
  durationMs: number;
  pushedCommit?: string;
  eventId: string;
  retired: boolean;
  decisionSummary?: DecisionSummaryWire;
}

interface HistoryWorkflowWire {
  label: string;
  gateRuns: HistoryGateRunWire[];
  verificationRuns: number;
  packages?: PackageRefWire[];
}

interface HistoryWaveWire {
  wave: string;
  crs: string[];
}

interface HistoryReleaseWire {
  labels: string[];
  state: "shipped" | "in progress" | "ship not recorded";
  shippedAt?: number;
  tag?: string;
  commit?: string;
  targetAt?: number;
  crCount: number;
  waves: HistoryWaveWire[];
  workflows: HistoryWorkflowWire[];
}

interface HistoryResponse {
  ok: true;
  releases: HistoryReleaseWire[];
}

interface ErrResponse {
  ok: false;
  error: string;
  [key: string]: unknown;
}

// ── shared fixture helpers ──────────────────────────────────────────────────

function seedProject(store: Store, name: string): string {
  const key = crypto.randomUUID();
  store.addProject({ key, name, type: "backend", sutRoot: "/tmp" });
  return key;
}

function seedQueue(
  store: Store,
  key: string,
  entries: Array<{ cr: string; wave: string; release?: string }>,
): void {
  store.replaceQueue(
    key,
    entries.map((e) => ({
      cr: e.cr,
      wave: e.wave,
      dependsOn: [],
      ...(e.release !== undefined ? { release: e.release } : {}),
    })),
  );
}

function fileCr(store: Store, key: string, cr: string): number {
  const plan = store.filePlan(key, { cr, cycles: [{ label: "solo", kind: "red-green" }] });
  if ("error" in plan) throw new Error(`CR-CRU-173 fixture: plan op refused for ${cr}: ${plan.error}`);
  return plan.planId;
}

/** File, seal and close a plan with a merge commit — the "a merged CR" fact. */
function mergeCr(store: Store, key: string, cr: string, commit: string): void {
  const planId = fileCr(store, key, cr);
  const plan = store.listPlans(key).find((p) => p.cr === cr);
  if (plan === undefined) throw new Error(`CR-CRU-173 fixture: no plan found for ${cr}`);
  const cycleId = plan.cycles[0]!.id;
  const active = store.transitionCycle(key, planId, cycleId, "active");
  if ("error" in active) throw new Error(`CR-CRU-173 fixture: activate refused for ${cr}: ${active.error}`);
  const done = store.transitionCycle(key, planId, cycleId, "done");
  if ("error" in done) throw new Error(`CR-CRU-173 fixture: done refused for ${cr}: ${done.error}`);
  const closed = store.closePlan(key, planId, { commit });
  if ("error" in closed) throw new Error(`CR-CRU-173 fixture: close refused for ${cr}: ${closed.error}`);
}

function postGateAt(
  store: Store,
  key: string,
  agentId: string,
  atMs: number,
  gate: Record<string, unknown>,
  meta: { version?: string; context?: { wave?: string } } = {},
): string {
  setSystemTime(atMs);
  return store.recordGateEvent(key, agentId, gate, meta).id;
}

function shipReleaseAt(
  store: Store,
  key: string,
  agentId: string,
  atMs: number,
  fields: { label: string; commit: string; crs: string[]; packages?: PackageRefWire[] },
): string {
  setSystemTime(atMs);
  const res = store.recordMilestoneEvent(key, agentId, "release", {
    label: fields.label,
    commit: fields.commit,
    releasedAt: Math.floor(atMs / 1000),
    crs: fields.crs,
    ...(fields.packages !== undefined ? { packages: fields.packages } : {}),
  });
  return res.event.id;
}

function proposeRelease(store: Store, key: string, agentId: string, label: string, targetAt: number): void {
  store.recordReleaseProposal(key, agentId, { label, targetAt });
}

function fileVerificationRun(store: Store, key: string, agentId: string, release: string): string {
  const run = { summary: { total: 1, passed: 1, failed: 0, pending: 0, duration_ms: 1 }, tree: [] };
  return store.recordTestEvent(key, agentId, run, { release }).id;
}

async function getHistory(handle: ServerHandle, key: string): Promise<Response> {
  return fetch(`http://localhost:${handle.server.port}/api/v2/projects/${key}/history`);
}

function waveOf(release: HistoryReleaseWire, wave: string): HistoryWaveWire | undefined {
  return release.waves.find((w) => w.wave === wave);
}

function workflowOf(release: HistoryReleaseWire, label: string): HistoryWorkflowWire {
  const wf = release.workflows.find((w) => w.label === label);
  if (wf === undefined) throw new Error(`no workflow for label ${label}`);
  return wf;
}

function releaseOf(response: HistoryResponse, label: string): HistoryReleaseWire {
  const rows = response.releases ?? [];
  const row = rows.find((r) => r.labels.includes(label));
  if (row === undefined) {
    throw new Error(
      `no release row carries label ${label} — history answered ${rows.length} row(s) ` +
        `(today's build: the route does not exist yet, so this is CR-CRU-173's RED)`,
    );
  }
  return row;
}

describe("CR-CRU-173 §S2 — GET /api/v2/projects/<key>/history", () => {
  // ── envelope + project existence ──────────────────────────────────────────

  describe("envelope and project existence", () => {
    let handle: ServerHandle | undefined;

    afterEach(() => {
      handle?.stop();
      handle = undefined;
      setSystemTime();
    });

    test("an unknown (but UUID-shaped) project answers 404 naming it, exactly like GET …/releases does", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const bogus = crypto.randomUUID();

      const res = await getHistory(handle, bogus);

      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrResponse;
      expect(body.ok).toBe(false);
      expect(body.error.toLowerCase()).toContain("unknown project");
      expect(body.error).toContain(bogus);
    });

    test("a project holding no release history at all answers 200 with an empty releases array — never 404", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = seedProject(handle.store, "history-empty-project");

      const res = await getHistory(handle, key);

      expect(res.status).toBe(200);
      const body = (await res.json()) as HistoryResponse;
      expect(body.ok).toBe(true);
      expect(body.releases).toEqual([]);
    });
  });

  // ── a rich board: 0.2.0 shipped, 0.2.2 fully-merged-unshipped, 0.3.0
  //    in-progress-unshipped, 0.4.0 excluded, 0.5.0 gated-by-wave-only ──────

  describe("a rich board mirroring the spec's own shapes", () => {
    let handle: ServerHandle;
    let key: string;
    let response: HistoryResponse;
    let historyStatus: number;
    let run1Id: string;
    let run2Id: string;
    let run3SealId: string;

    const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);
    const MIN = 60_000;

    beforeAll(async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      key = seedProject(handle.store, "history-rich-board");
      const store = handle.store;
      const agent = "fixture-orchestrator";

      // ── the queue: every CR this fixture touches, with its WAVE and (where
      //    declared) its QUEUE-DECLARED release ─────────────────────────────
      seedQueue(store, key, [
        { cr: "HIST-410", wave: "4" },
        { cr: "HIST-411", wave: "4" },
        { cr: "HIST-412", wave: "4" },
        { cr: "HIST-420", wave: "5" },
        { cr: "HIST-421", wave: "5" },
        { cr: "HIST-430", wave: "6" },
        { cr: "HIST-431", wave: "6" },
        { cr: "HIST-432", wave: "6" },
        // CR-CRU-173 §S2's own example (0.2.0's crs names a CR the queue
        // files under a different release): wave 6, but queue-declared 0.3.0.
        { cr: "HIST-499", wave: "6", release: "0.3.0" },
        { cr: "HIST-800", wave: "8", release: "0.3.0" },
        { cr: "HIST-801", wave: "8", release: "0.3.0" },
        { cr: "HIST-700", wave: "7", release: "0.2.2" },
        { cr: "HIST-701", wave: "7", release: "0.2.2" },
        { cr: "HIST-702", wave: "7", release: "0.2.2" },
        { cr: "HIST-703", wave: "7", release: "0.2.2" },
        { cr: "HIST-900", wave: "9", release: "0.5.0" },
      ]);

      // ── targets declared for every unshipped release, 0.4.0 included ─────
      proposeRelease(store, key, agent, "0.2.2", 1_795_000_000);
      proposeRelease(store, key, agent, "0.3.0", 1_800_000_000);
      proposeRelease(store, key, agent, "0.4.0", 1_805_000_000); // nothing else — excluded
      proposeRelease(store, key, agent, "0.5.0", 1_810_000_000);

      // ── 0.2.2: ALL four CRs merged, nothing shipped -> "ship not recorded" ─
      mergeCr(store, key, "HIST-700", "merge700a");
      mergeCr(store, key, "HIST-701", "merge701a");
      mergeCr(store, key, "HIST-702", "merge702a");
      mergeCr(store, key, "HIST-703", "merge703a");
      fileVerificationRun(store, key, agent, "0.2.2");
      fileVerificationRun(store, key, agent, "0.2.2");

      // ── 0.5.0: ONE CR with an OPEN (never closed) plan — "a plan" alone
      //    qualifies the release, and nothing merged keeps it "in progress" ──
      fileCr(store, key, "HIST-900");

      // ── 0.2.0's three gate runs, seal-bounded (no runId — pre-CR-162 era),
      //    every snapshot naming wave 6 (the last wave before this release,
      //    never a version except the final seal) ───────────────────────────
      run1Id = postGateAt(
        store,
        key,
        agent,
        T0,
        { intent: "wave 6 no-mistakes gate", outcome: "passed", steps: [{ name: "review", status: "passed" }] },
        { context: { wave: "6" } },
      );
      run2Id = postGateAt(
        store,
        key,
        agent,
        T0 + 10 * MIN,
        { intent: "wave 6 no-mistakes gate", outcome: "cancelled", steps: [{ name: "review", status: "cancelled" }] },
        { context: { wave: "6" } },
      );
      for (let i = 0; i < 10; i++) {
        postGateAt(
          store,
          key,
          agent,
          T0 + (20 + i) * MIN,
          {
            intent: "wave 6 no-mistakes gate",
            outcome: "checks-passed",
            inFlight: true,
            steps: [{ name: "review", status: i === 4 ? "fixing" : "running" }],
          },
          { context: { wave: "6" } },
        );
      }
      run3SealId = postGateAt(
        store,
        key,
        agent,
        T0 + 40 * MIN,
        {
          intent: "wave 6 no-mistakes gate",
          outcome: "passed",
          steps: [
            { name: "review", status: "passed" },
            { name: "push", status: "passed" },
          ],
          push: { commit: "4cda68f0" },
        },
        { context: { wave: "6" }, version: "0.2.0" },
      );

      // ── 0.2.0 ships AFTER its gates — retires run3's versioned seal, never
      //    run1/run2 (version-less) ──────────────────────────────────────────
      shipReleaseAt(store, key, agent, T0 + 41 * MIN, {
        label: "0.2.0",
        commit: "aaa0002b",
        crs: [
          "HIST-410",
          "HIST-411",
          "HIST-412",
          "HIST-420",
          "HIST-421",
          "HIST-430",
          "HIST-431",
          "HIST-432",
          "HIST-499",
        ],
        packages: [{ registry: "npm", name: "@fixture/crucible-history", version: "0.2.0" }],
      });

      // ── 0.3.0: one merged CR (keeps it "in progress", not "ship not
      //    recorded", since HIST-499/801 stay pending), one runId-grouped
      //    gate run naming the release directly by version ───────────────────
      mergeCr(store, key, "HIST-800", "merge8000001");
      postGateAt(
        store,
        key,
        agent,
        T0 + 60 * MIN,
        {
          intent: "wave 8 no-mistakes gate",
          outcome: "checks-passed",
          inFlight: true,
          steps: [{ name: "review", status: "fixing" }],
          run: { id: "run-030-a" },
        },
        { context: { wave: "8" }, version: "0.3.0" },
      );
      postGateAt(
        store,
        key,
        agent,
        T0 + 65 * MIN,
        {
          intent: "wave 8 no-mistakes gate",
          outcome: "passed",
          steps: [{ name: "review", status: "passed" }],
          run: { id: "run-030-a" },
        },
        { context: { wave: "8" }, version: "0.3.0" },
      );

      // ── 0.5.0: a gate naming NO release at all — attributed by the wave
      //    (9) its snapshot names, the ONE release that wave belongs to ──────
      postGateAt(
        store,
        key,
        agent,
        T0 + 70 * MIN,
        { intent: "wave 9 no-mistakes gate", outcome: "passed", steps: [{ name: "solo", status: "passed" }] },
        { context: { wave: "9" } },
      );

      // NEVER `expect` inside beforeAll: a thrown assertion here would abort
      // the WHOLE describe block (bun skips, rather than fails, every test
      // whose beforeAll threw) — exactly the "silently skipped" failure mode
      // the RED workflow forbids. Each test below asserts the status/shape
      // it needs for itself, so a 404-shaped (route-not-yet-built) response
      // fails every single one of them individually, loudly.
      setSystemTime();
      const res = await getHistory(handle, key);
      historyStatus = res.status;
      response = (await res.json()) as HistoryResponse;
    });

    afterAll(() => {
      handle.stop();
      setSystemTime();
    });

    test("the read answers 200 (not the route-missing 404 today's build still gives it)", () => {
      expect(historyStatus).toBe(200);
    });

    test("only releases holding real history are listed, newest version first — 0.4.0 (a declared target with nothing merged, planned or gated) is absent", () => {
      const labels = response.releases.map((r) => r.labels[0]);
      expect(labels).toEqual(["0.5.0", "0.3.0", "0.2.2", "0.2.0"]);
      expect(response.releases.some((r) => r.labels.includes("0.4.0"))).toBe(false);
    });

    test("a shipped release reads state 'shipped', its own tag and commit, its combined CR count and its packages", () => {
      const row = releaseOf(response, "0.2.0");
      expect(row.state).toBe("shipped");
      expect(row.shippedAt).toBe(Math.floor((T0 + 41 * MIN) / 1000));
      expect(row.tag).toBe("v0.2.0");
      expect(row.commit).toBe("aaa0002b");
      expect(row.crCount).toBe(9);
      expect(workflowOf(row, "0.2.0").packages).toEqual([
        { registry: "npm", name: "@fixture/crucible-history", version: "0.2.0" },
      ]);
    });

    test("an unshipped release whose CRs are ALL merged reads 'ship not recorded' — no tag, no commit, no packages, and an empty (never absent) gate-runs list", () => {
      const row = releaseOf(response, "0.2.2");
      expect(row.state).toBe("ship not recorded");
      expect("tag" in row).toBe(false);
      expect("commit" in row).toBe(false);
      expect("shippedAt" in row).toBe(false);
      expect(row.crCount).toBe(4);
      const wf = workflowOf(row, "0.2.2");
      expect(wf.gateRuns).toEqual([]);
      expect("packages" in wf).toBe(false);
    });

    test("an unshipped release with pending (unmerged) CRs reads 'in progress'", () => {
      const row = releaseOf(response, "0.3.0");
      expect(row.state).toBe("in progress");
      expect(row.targetAt).toBe(1_800_000_000);
    });

    test("a shipped release's record `crs` wins over the queue's `release` field; the CR it names which the queue files under a DIFFERENT (also-listed) release appears under BOTH, each keeping only that release's own CRs", () => {
      const shipped = releaseOf(response, "0.2.0");
      const unshipped = releaseOf(response, "0.3.0");

      // 0.2.0's record names HIST-499 even though the queue files it
      // under 0.3.0 — the record wins for the SHIPPED release.
      expect(waveOf(shipped, "6")?.crs).toContain("HIST-499");
      // 0.3.0 (unshipped) takes its CRs from the queue, which also names it.
      expect(waveOf(unshipped, "8")?.crs).toContain("HIST-800");
      expect(waveOf(unshipped, "8")?.crs).toContain("HIST-801");

      // Honestly double-counted: present under BOTH releases.
      const in020 = shipped.waves.flatMap((w) => w.crs).includes("HIST-499");
      const in030 = unshipped.waves.flatMap((w) => w.crs).includes("HIST-499");
      expect(in020).toBe(true);
      expect(in030).toBe(true);
    });

    test("a release's waves are latest-first, and a wave split across releases carries only THAT release's own CR ids under each", () => {
      const shipped = releaseOf(response, "0.2.0");
      expect(shipped.waves.map((w) => w.wave)).toEqual(["6", "5", "4"]);
      expect(waveOf(shipped, "6")?.crs.sort()).toEqual(
        ["HIST-430", "HIST-431", "HIST-432", "HIST-499"].sort(),
      );
      expect(waveOf(shipped, "5")?.crs.sort()).toEqual(["HIST-420", "HIST-421"].sort());
      expect(waveOf(shipped, "4")?.crs.sort()).toEqual(["HIST-410", "HIST-411", "HIST-412"].sort());

      // Wave 6 ALSO appears under 0.3.0 — same number, only ITS OWN cr.
      const unshipped = releaseOf(response, "0.3.0");
      expect(unshipped.waves.map((w) => w.wave)).toEqual(["8", "6"]);
      expect(waveOf(unshipped, "6")?.crs).toEqual(["HIST-499"]);
    });

    test("gate snapshots carrying NO runId group seal-bounded, newest run first: a bare passed seal, a cancelled-at-review seal, each its own one-snapshot run", () => {
      const row = releaseOf(response, "0.2.0");
      const runs = workflowOf(row, "0.2.0").gateRuns;
      expect(runs.length).toBe(3);

      const run2 = runs.find((r) => r.eventId === run2Id);
      expect(run2).toBeDefined();
      expect(run2!.outcome).toBe("cancelled");
      expect(run2!.stopStep).toBe("review");
      expect(run2!.fixRounds).toBe(0);
      expect(run2!.durationMs).toBe(0);
      expect(run2!.runId).toBeUndefined();

      const run1 = runs.find((r) => r.eventId === run1Id);
      expect(run1).toBeDefined();
      expect(run1!.outcome).toBe("passed");
      expect(run1!.stopStep).toBeUndefined();
      expect(run1!.fixRounds).toBe(0);
      expect(run1!.durationMs).toBe(0);
      expect("pushedCommit" in run1!).toBe(false);

      // newest (run3's seal) first
      expect(runs[0]!.eventId).toBe(run3SealId);
    });

    test("ten in-flight snapshots then a seal group into ONE run: fix rounds counts the one step that entered 'fixing', duration spans first snapshot -> seal, the pushed commit is surfaced, and the seal IS retired (the release it gated has since shipped) — the one read that still returns it", () => {
      const row = releaseOf(response, "0.2.0");
      const run3 = workflowOf(row, "0.2.0").gateRuns.find((r) => r.eventId === run3SealId);
      expect(run3).toBeDefined();
      expect(run3!.outcome).toBe("passed");
      expect(run3!.stopStep).toBeUndefined();
      expect(run3!.fixRounds).toBe(1);
      expect(run3!.durationMs).toBe(20 * MIN);
      expect(run3!.pushedCommit).toBe("4cda68f0");
      expect(run3!.retired).toBe(true);

      // The two sibling runs were NEVER named by the ship — live, not retired.
      const run1 = workflowOf(row, "0.2.0").gateRuns.find((r) => r.eventId === run1Id);
      const run2 = workflowOf(row, "0.2.0").gateRuns.find((r) => r.eventId === run2Id);
      expect(run1!.retired).toBe(false);
      expect(run2!.retired).toBe(false);
    });

    test("gate snapshots sharing the SAME runId group into one run regardless of how many are in flight, distinct from a seal-bounded sibling with no runId", () => {
      const row = releaseOf(response, "0.3.0");
      const runs = workflowOf(row, "0.3.0").gateRuns;
      expect(runs.length).toBe(1);
      const run = runs[0]!;
      expect(run.runId).toBe("run-030-a");
      expect(run.outcome).toBe("passed");
      expect(run.stopStep).toBeUndefined();
      expect(run.fixRounds).toBe(1);
      expect(run.durationMs).toBe(5 * MIN);
      expect(run.retired).toBe(false);
    });

    test("a gate naming NO release belongs to the release of the wave it gated", () => {
      const row = releaseOf(response, "0.5.0");
      const runs = workflowOf(row, "0.5.0").gateRuns;
      expect(runs.length).toBe(1);
      expect(runs[0]!.outcome).toBe("passed");
      expect(runs[0]!.runId).toBeUndefined();
      expect(row.state).toBe("in progress");
    });

    test("verification is the count of runs filed under the release (CR-CRU-164) — zero when none were, a real count when some were", () => {
      const shipped = releaseOf(response, "0.2.0");
      const merged = releaseOf(response, "0.2.2");
      expect(workflowOf(shipped, "0.2.0").verificationRuns).toBe(0);
      expect(workflowOf(merged, "0.2.2").verificationRuns).toBe(2);
    });

    test("the `→ gate` drill-in — GET /api/v2/events/<newest snapshot id> — answers for a RETIRED gate too (today's behaviour, pinned)", async () => {
      const res = await fetch(`http://localhost:${handle.server.port}/api/v2/events/${run3SealId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: true; event: { id: string; retiredAt?: number; gate?: unknown } };
      expect(body.ok).toBe(true);
      expect(body.event.id).toBe(run3SealId);
      expect(typeof body.event.retiredAt).toBe("number");
      expect(body.event.gate).toBeDefined();
    });
  });

  // ── one row per release: same-day shipping never merges rows (user ruling
  //    2026-10-08), nor does different-day shipping ─────────────────────────

  describe("one row per release", () => {
    let handle: ServerHandle | undefined;

    afterEach(() => {
      handle?.stop();
      handle = undefined;
      setSystemTime();
    });

    test("releases shipped the same day are separate rows, each with its own CRs and waves", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = seedProject(handle.store, "history-same-day-merge");
      const store = handle.store;
      const agent = "fixture-orchestrator";
      const day = Date.UTC(2026, 7, 19, 0, 0, 0);

      seedQueue(store, key, [
        { cr: "HIST-601", wave: "1" },
        { cr: "HIST-602", wave: "1" },
        { cr: "HIST-611", wave: "2" },
      ]);

      postGateAt(
        store,
        key,
        agent,
        day + 8 * 3_600_000,
        { intent: "wave 1 gate", outcome: "failed", steps: [{ name: "test", status: "failed" }] },
        { context: { wave: "1" }, version: "0.6.0" },
      );
      shipReleaseAt(store, key, agent, day + 9 * 3_600_000, {
        label: "0.6.0",
        commit: "six0a",
        crs: ["HIST-601", "HIST-602"],
      });

      postGateAt(
        store,
        key,
        agent,
        day + 15 * 3_600_000,
        { intent: "wave 2 gate", outcome: "passed", steps: [{ name: "test", status: "passed" }] },
        { context: { wave: "2" }, version: "0.6.1" },
      );
      shipReleaseAt(store, key, agent, day + 16 * 3_600_000, {
        label: "0.6.1",
        commit: "six1a",
        crs: ["HIST-611"],
      });

      setSystemTime();
      const res = await getHistory(handle, key);
      expect(res.status).toBe(200);
      const body = (await res.json()) as HistoryResponse;

      expect(body.releases.map((r) => r.labels)).toEqual([["0.6.1"], ["0.6.0"]]);
      const row1 = releaseOf(body, "0.6.1");
      const row0 = releaseOf(body, "0.6.0");
      expect(row1.state).toBe("shipped");
      expect(row0.state).toBe("shipped");
      expect(row1.crCount).toBe(1);
      expect(row0.crCount).toBe(2);
      expect(row1.waves).toEqual([{ wave: "2", crs: ["HIST-611"] }]);
      expect(row0.waves.map((w) => w.wave)).toEqual(["1"]);
      expect(waveOf(row0, "1")?.crs.sort()).toEqual(["HIST-601", "HIST-602"]);

      expect(row1.workflows.map((w) => w.label)).toEqual(["0.6.1"]);
      expect(row0.workflows.map((w) => w.label)).toEqual(["0.6.0"]);
      const wf0 = workflowOf(row0, "0.6.0");
      const wf1 = workflowOf(row1, "0.6.1");
      expect(wf0.gateRuns.length).toBe(1);
      expect(wf0.gateRuns[0]!.outcome).toBe("failed");
      expect(wf1.gateRuns.length).toBe(1);
      expect(wf1.gateRuns[0]!.outcome).toBe("passed");
    });

    test("two releases shipped on DIFFERENT calendar days do NOT merge — two separate rows", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = seedProject(handle.store, "history-different-day-no-merge");
      const store = handle.store;
      const agent = "fixture-orchestrator";

      seedQueue(store, key, [
        { cr: "HIST-621", wave: "1" },
        { cr: "HIST-631", wave: "2" },
      ]);

      shipReleaseAt(store, key, agent, Date.UTC(2026, 7, 19, 10, 0, 0), {
        label: "0.6.2",
        commit: "six2a",
        crs: ["HIST-621"],
      });
      shipReleaseAt(store, key, agent, Date.UTC(2026, 7, 20, 10, 0, 0), {
        label: "0.6.3",
        commit: "six3a",
        crs: ["HIST-631"],
      });

      setSystemTime();
      const res = await getHistory(handle, key);
      const body = (await res.json()) as HistoryResponse;

      expect(body.releases.length).toBe(2);
      expect(body.releases.map((r) => r.labels)).toEqual([["0.6.3"], ["0.6.2"]]);
    });
  });

  // ── a gate naming neither a release nor a wave (user ruling 2026-10-08) ──────

  describe("a gate naming neither a release nor a wave", () => {
    let handle: ServerHandle | undefined;

    afterEach(() => {
      handle?.stop();
      handle = undefined;
      setSystemTime();
    });

    test("belongs to the first release that shipped at or after it; one sealed after every ship belongs to the lowest unshipped release", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = seedProject(handle.store, "history-unnamed-gate");
      const store = handle.store;
      const agent = "fixture-orchestrator";
      const day = Date.UTC(2026, 8, 9, 0, 0, 0);
      const HOUR = 3_600_000;

      seedQueue(store, key, [
        { cr: "HIST-690", wave: "1" },
        { cr: "HIST-700", wave: "2" },
        { cr: "HIST-900", wave: "3", release: "0.9.0" },
      ]);
      proposeRelease(store, key, agent, "0.8.0", 1_830_000_000);
      proposeRelease(store, key, agent, "0.9.0", 1_840_000_000);
      fileCr(store, key, "HIST-900"); // an open plan: 0.9.0 has history of its own

      shipReleaseAt(store, key, agent, day + 1 * HOUR, {
        label: "0.6.9",
        commit: "six9a",
        crs: ["HIST-690"],
      });
      // version-less, wave-less, run-less, sealed — AFTER 0.6.9 shipped,
      // BEFORE 0.7.0 did: it belongs to 0.7.0.
      const beforeShip = postGateAt(store, key, agent, day + 2 * HOUR, {
        intent: "release gate",
        outcome: "passed",
        steps: [{ name: "review", status: "passed" }],
      });
      shipReleaseAt(store, key, agent, day + 3 * HOUR, {
        label: "0.7.0",
        commit: "seven0a",
        crs: ["HIST-700"],
      });
      // the same kind of gate AFTER every ship: the lowest unshipped release.
      const afterShips = postGateAt(store, key, agent, day + 4 * HOUR, {
        intent: "release gate",
        outcome: "failed",
        steps: [{ name: "test", status: "failed" }],
      });

      setSystemTime();
      const res = await getHistory(handle, key);
      expect(res.status).toBe(200);
      const body = (await res.json()) as HistoryResponse;

      const r070 = workflowOf(releaseOf(body, "0.7.0"), "0.7.0").gateRuns;
      expect(r070.map((r) => r.eventId)).toEqual([beforeShip]);
      expect(r070[0]!.outcome).toBe("passed");
      expect(workflowOf(releaseOf(body, "0.6.9"), "0.6.9").gateRuns).toEqual([]);

      const r080 = workflowOf(releaseOf(body, "0.8.0"), "0.8.0").gateRuns;
      expect(r080.map((r) => r.eventId)).toEqual([afterShips]);
      expect(r080[0]!.outcome).toBe("failed");
      expect(r080[0]!.stopStep).toBe("test");
      expect(workflowOf(releaseOf(body, "0.9.0"), "0.9.0").gateRuns).toEqual([]);
    });
  });

  // ── a gate run's decisions summary ────────────────────────────────────────

  describe("a gate run's decisions summary", () => {
    let handle: ServerHandle | undefined;

    afterEach(() => {
      handle?.stop();
      handle = undefined;
    });

    test("a gate run with recorded decisions carries a decisionSummary computed with the SAME counting rules the events list uses (decisions, fixed DISTINCT, added, declined over approved steps only, approvedWithReason)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = seedProject(handle.store, "history-decision-summary");
      const store = handle.store;
      const agent = "fixture-orchestrator";

      proposeRelease(store, key, agent, "0.9.9", 1_820_000_000);
      store.recordGateEvent(
        key,
        agent,
        {
          intent: "release gate",
          outcome: "passed",
          steps: [{ name: "review", status: "passed", findings: 5 }],
          run: { id: "run-dec-a" },
        },
        { version: "0.9.9" },
      );
      store.recordGateDecision(key, agent, {
        runId: "run-dec-a",
        action: "fix",
        step: "review",
        findings: ["f1", "f2"],
      });
      store.recordGateDecision(key, agent, {
        runId: "run-dec-a",
        action: "approve",
        step: "review",
        reason: "looks fine",
      });

      const res = await getHistory(handle, key);
      const body = (await res.json()) as HistoryResponse;
      const row = releaseOf(body, "0.9.9");
      const run = workflowOf(row, "0.9.9").gateRuns[0]!;

      expect(run.decisionSummary).toEqual({
        decisions: 2,
        fixed: 2,
        added: 0,
        declined: 3, // 5 step findings − 2 distinct fixed
        approvedWithReason: 1,
      });
    });

    test("a gate run with ZERO recorded decisions carries no decisionSummary key at all — absent, never a zeroed object", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = seedProject(handle.store, "history-decision-summary-none");
      const store = handle.store;
      const agent = "fixture-orchestrator";

      proposeRelease(store, key, agent, "0.9.8", 1_820_000_000);
      store.recordGateEvent(
        key,
        agent,
        {
          intent: "release gate",
          outcome: "passed",
          steps: [{ name: "review", status: "passed", findings: 2 }],
          run: { id: "run-dec-none" },
        },
        { version: "0.9.8" },
      );

      const res = await getHistory(handle, key);
      const body = (await res.json()) as HistoryResponse;
      const row = releaseOf(body, "0.9.8");
      const run = workflowOf(row, "0.9.8").gateRuns[0]!;

      expect("decisionSummary" in run).toBe(false);
    });
  });
});
