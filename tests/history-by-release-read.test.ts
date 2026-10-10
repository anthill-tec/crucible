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
//     state: "shipped" | "in progress" | "ship not recorded"   // CR-CRU-177: "planned" withdrawn
//     shippedAt?: number          // epoch SECONDS, present iff shipped
//     tag?: string                // "v<label>", present iff shipped
//     commit?: string             // present iff shipped
//     targetAt?: number           // epoch SECONDS, present iff a target is declared
//     crCount: number             // CR-CRU-177: the release's own COMPLETED CRs only
//     pendingCount: number        // CR-CRU-177: the rest of the release's own CRs (0 when none)
//     waves: { wave: string; crs: string[]; pendingCount: number }[]   // latest-first, crs COMPLETED only
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
//   USER RULING 2026-10-09 (cycle 637, SUPERSEDED by CR-CRU-177 below) —
//   "planned" and "nothing left outside History": every release that HOLDS
//   WORK is listed, including a future one with only queued CRs and nothing
//   started — state "planned". Kept here for context only; the tests that
//   pinned it are re-pinned below (CR-CRU-177).
//
//   A CR, release-less wave or runs-only inferred wave that no release
//   record and no queue `release` names lands under the first release that
//   shipped at or after it (a CR/wave: its plan's close time; a runs-only
//   wave: its first run's time), else the lowest unshipped release — the
//   same timeline rule §S2 already applies to a gate naming neither a
//   release nor a wave. This placement rule itself is untouched by
//   CR-CRU-177 (the released-CR-completeness rule below applies AFTER a CR
//   or run has been placed).
//
// ── CR-CRU-177 — "History shows only the past" (cycle 642, RED) ───────────
//
//   This CR revises the cycle-637 ruling above, PATCHING §S1/§S2 only:
//
//   §S1 — an unshipped release is listed only when it has shipped OR holds
//   history of its own: at least one COMPLETED CR (merged: a closed plan
//   with a merge commit, or named by a shipped release record), or — RED's
//   call, stated here rather than guessed at, since the spec's "nothing
//   completed" sentence governs CR completion and the spec's closing clause
//   keeps "gate runs … as built" — at least one gate run attributed to it.
//   A release with ONLY queued or filed-but-never-merged ("in-flight") CRs
//   and no gate run of its own holds no history and is NOT listed; the
//   `planned` state is WITHDRAWN outright (never answered, not even for a
//   release that would have qualified for it under cycle 637). A shipped
//   release is listed even when its record names no CRs at all (0.1.1).
//
//   §S2 — `crCount` (release row) and each wave's `crs` hold COMPLETED CRs
//   only (the same completion test as §S1); the release row and each wave
//   gain `pendingCount` — the release's/wave's CRs that are NOT completed —
//   present always, 0 when none. A wave whose CRs are ALL pending carries no
//   row of its own (only folded into the release's own pendingCount).
//
//   Tests this CR re-pins (one separate commit, test(CR-CRU-177): History's
//   planned and pending pins follow only-the-past): the "planned"-state
//   describe block below (now: not listed, no state answers 'planned'); the
//   crCount/crs assertions that counted a pending CR (now: completed only,
//   pendingCount asserted beside); the "withdrawn work" describe block's
//   crCount/crs assertions (same reason). Every OTHER describe block whose
//   release held nothing but a gate run or an open (never-merged) plan — and
//   whose test is actually ABOUT something else (gate placement, a decision
//   summary) — keeps that release listed by giving it one completed CR in
//   the fixture, so the test's own assertions stand unchanged; only the
//   fixture and its comments move. (Orchestrator ruling 2026-10-09: keep
//   each test's purpose — flip to absent only where listing/state IS the
//   point; otherwise give the release a completed CR.)
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
  pendingCount: number;
}

interface HistoryReleaseWire {
  labels: string[];
  state: "shipped" | "in progress" | "ship not recorded";
  shippedAt?: number;
  tag?: string;
  commit?: string;
  targetAt?: number;
  crCount: number;
  pendingCount: number;
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

/**
 * File, seal and close a plan with a merge commit AT A SPECIFIC INSTANT —
 * `store.closePlan` stamps `closedAt` from `Date.now()`, so this is the
 * "a plan closed at <time>" fact the cycle-637 orphan-placement ruling reads
 * (a CR no release names lands under the release that ships at or after its
 * plan's CLOSE time).
 */
function mergeCrAt(store: Store, key: string, cr: string, commit: string, atMs: number): void {
  setSystemTime(atMs);
  mergeCr(store, key, cr, commit);
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
        { cr: "HIST-901", wave: "9", release: "0.5.0" },
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

      // ── 0.5.0: ONE merged (completed) CR keeps the release listed per
      //    CR-CRU-177 §S1 (a gate run alone — see below — would also keep it
      //    listed, RED's call; this merge additionally proves pendingCount);
      //    HIST-901 stays queued/pending, which keeps it "in progress" ──────
      mergeCr(store, key, "HIST-900", "ninehundreda");

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
      // CR-CRU-177 \u00a7S2: every CR a shipped record names is, by definition,
      // completed \u2014 a shipped release never carries a pending CR.
      expect(row.pendingCount).toBe(0);
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
      expect(row.pendingCount).toBe(0);
      const wf = workflowOf(row, "0.2.2");
      expect(wf.gateRuns).toEqual([]);
      expect("packages" in wf).toBe(false);
    });

    test("an unshipped release with pending (unmerged) CRs reads 'in progress', and CR-CRU-177 \u00a7S2's crCount/pendingCount count the completed CR and the rest, separately (HIST-800 merged; HIST-499 completed via 0.2.0's shipped record; HIST-801 still queued/pending)", () => {
      const row = releaseOf(response, "0.3.0");
      expect(row.state).toBe("in progress");
      expect(row.targetAt).toBe(1_800_000_000);
      expect(row.crCount).toBe(2);
      expect(row.pendingCount).toBe(1);
    });

    test("a shipped release's record `crs` wins over the queue's `release` field; the CR it names which the queue files under a DIFFERENT (also-listed) release appears under BOTH, each keeping only that release's own COMPLETED CRs (CR-CRU-177 re-pin: a pending CR is counted, never listed)", () => {
      const shipped = releaseOf(response, "0.2.0");
      const unshipped = releaseOf(response, "0.3.0");

      // 0.2.0's record names HIST-499 even though the queue files it
      // under 0.3.0 — the record wins for the SHIPPED release.
      expect(waveOf(shipped, "6")?.crs).toContain("HIST-499");
      // 0.3.0 (unshipped) takes its merged CR from the queue, which also
      // names it — HIST-800 is merged (completed); HIST-801 is still
      // queued/pending, so it holds no `crs` entry of its own, only the
      // wave's pendingCount (CR-CRU-177 §S2).
      expect(waveOf(unshipped, "8")?.crs).toEqual(["HIST-800"]);
      expect(waveOf(unshipped, "8")?.crs).not.toContain("HIST-801");
      expect(waveOf(unshipped, "8")?.pendingCount).toBe(1);

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
      // CR-CRU-177 \u00a7S2: HIST-900 merged (completed), HIST-901 still queued.
      expect(row.crCount).toBe(1);
      expect(row.pendingCount).toBe(1);
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
      expect(row1.waves).toEqual([{ wave: "2", crs: ["HIST-611"], pendingCount: 0 }]);
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
        { cr: "HIST-880", wave: "10", release: "0.8.0" },
        { cr: "HIST-900", wave: "3", release: "0.9.0" },
      ]);
      proposeRelease(store, key, agent, "0.8.0", 1_830_000_000);
      proposeRelease(store, key, agent, "0.9.0", 1_840_000_000);
      // CR-CRU-177: this test is about GATE PLACEMENT, not listing \u2014 both
      // 0.8.0 and 0.9.0 need a completed CR of their own to stay listed
      // (orchestrator ruling 2026-10-09), so their gateRuns stay observable.
      mergeCr(store, key, "HIST-880", "eighty880a");
      mergeCr(store, key, "HIST-900", "ninehundreda");

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
      // CR-CRU-177: this test is about the decisionSummary shape, not
      // listing \u2014 0.9.9 needs a completed CR of its own to stay listed
      // (orchestrator ruling 2026-10-09).
      seedQueue(store, key, [{ cr: "HIST-699", wave: "50", release: "0.9.9" }]);
      mergeCr(store, key, "HIST-699", "nine699a");
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
      // CR-CRU-177: ditto \u2014 0.9.8 needs a completed CR to stay listed.
      seedQueue(store, key, [{ cr: "HIST-698", wave: "50", release: "0.9.8" }]);
      mergeCr(store, key, "HIST-698", "nine698a");
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

  // \u2500\u2500 user ruling 2026-10-09 (cycle 637): every release that holds work is
  //    listed \u2014 including a future one with only queued CRs, state "planned";
  //    a release with NO work at all stays excluded \u2500\u2500

  describe("release states: planned, in progress, and still-excluded-when-empty (user ruling 2026-10-09)", () => {
    let handle: ServerHandle | undefined;

    afterEach(() => {
      handle?.stop();
      handle = undefined;
      setSystemTime();
    });

    test("CR-CRU-177 re-pin: an unshipped release holding ONLY queued CRs and NOTHING started is NOT listed at all \u2014 the flip of the cycle-637 'planned' ruling; a sibling release whose one CR's plan was merely FILED (never merged) is ALSO not listed \u2014 an open plan is still only 'in-flight', not completed, so it earns the release no row either, and no state anywhere in the response ever reads 'planned'", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = seedProject(handle.store, "history-planned-vs-in-progress");
      const store = handle.store;
      const agent = "fixture-orchestrator";

      seedQueue(store, key, [
        { cr: "HIST-940", wave: "20", release: "0.9.4" },
        { cr: "HIST-941", wave: "20", release: "0.9.4" },
        { cr: "HIST-942", wave: "20", release: "0.9.4" },
        { cr: "HIST-950", wave: "21", release: "0.9.6" },
        { cr: "HIST-951", wave: "21", release: "0.9.6" },
      ]);
      proposeRelease(store, key, agent, "0.9.4", 1_850_000_000);
      proposeRelease(store, key, agent, "0.9.6", 1_852_000_000);
      fileCr(store, key, "HIST-950"); // opened, NEVER merged \u2014 still only in-flight, not completed

      const res = await getHistory(handle, key);
      expect(res.status).toBe(200);
      const body = (await res.json()) as HistoryResponse;

      expect(body.releases.some((r) => r.labels.includes("0.9.4"))).toBe(false);
      expect(body.releases.some((r) => r.labels.includes("0.9.6"))).toBe(false);
      expect(body.releases.every((r) => (r.state as string) !== "planned")).toBe(true);
    });

    test("CR-CRU-177: an unshipped release with exactly ONE completed CR alongside queued siblings IS listed, state 'in progress', crCount counting the completed CR only and pendingCount counting the rest", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = seedProject(handle.store, "history-one-completed-cr-lists-release");
      const store = handle.store;
      const agent = "fixture-orchestrator";

      seedQueue(store, key, [
        { cr: "HIST-943", wave: "20", release: "0.9.3" },
        { cr: "HIST-944", wave: "20", release: "0.9.3" },
        { cr: "HIST-945", wave: "20", release: "0.9.3" },
      ]);
      proposeRelease(store, key, agent, "0.9.3", 1_849_000_000);
      mergeCr(store, key, "HIST-943", "nine43a");

      const res = await getHistory(handle, key);
      expect(res.status).toBe(200);
      const body = (await res.json()) as HistoryResponse;

      const row = releaseOf(body, "0.9.3");
      expect(row.state).toBe("in progress");
      expect(row.crCount).toBe(1);
      expect(row.pendingCount).toBe(2);
      expect(waveOf(row, "20")?.crs).toEqual(["HIST-943"]);
      expect(waveOf(row, "20")?.pendingCount).toBe(2);
    });

    test("CR-CRU-177: a shipped release whose record names NO CRs at all is still listed (0.1.1 at gap analysis) \u2014 a shipped release is past regardless of its CR count", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = seedProject(handle.store, "history-shipped-no-crs-still-listed");
      const store = handle.store;
      const agent = "fixture-orchestrator";

      shipReleaseAt(store, key, agent, Date.UTC(2026, 0, 15, 12, 0, 0), {
        label: "0.1.1",
        commit: "onepointonea",
        crs: [],
      });

      const res = await getHistory(handle, key);
      expect(res.status).toBe(200);
      const body = (await res.json()) as HistoryResponse;

      const row = releaseOf(body, "0.1.1");
      expect(row.state).toBe("shipped");
      expect(row.crCount).toBe(0);
      expect(row.pendingCount).toBe(0);
      expect(row.waves).toEqual([]);
    });

    test("a declared target release with NO queued CRs and nothing else is STILL not listed at all (user ruling 2026-10-09: a release with no work stays excluded)", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = seedProject(handle.store, "history-no-work-still-excluded");
      const store = handle.store;
      const agent = "fixture-orchestrator";

      proposeRelease(store, key, agent, "0.9.5", 1_851_000_000);

      const res = await getHistory(handle, key);
      expect(res.status).toBe(200);
      const body = (await res.json()) as HistoryResponse;
      expect(body.releases).toEqual([]);
      expect(body.releases.some((r) => r.labels.includes("0.9.5"))).toBe(false);
    });
  });

  // \u2500\u2500 placing a CR no release names: by its plan's CLOSE time, against the
  //    ship timeline (user ruling 2026-10-09) \u2500\u2500

  describe("placing a CR no release record and no queue release names (user ruling 2026-10-09)", () => {
    let handle: ServerHandle | undefined;

    afterEach(() => {
      handle?.stop();
      handle = undefined;
      setSystemTime();
    });

    test("an orphan CR's plan closed between two ships lands under the LATER-shipping release; one closed after EVERY ship lands under the LOWEST unshipped release", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = seedProject(handle.store, "history-orphan-cr-placement");
      const store = handle.store;
      const agent = "fixture-orchestrator";
      const day = Date.UTC(2026, 8, 20, 0, 0, 0);
      const HOUR = 3_600_000;

      seedQueue(store, key, [
        { cr: "HIST-960", wave: "22" },
        { cr: "HIST-970", wave: "23" },
        { cr: "HIST-980", wave: "24" }, // orphan: no release anywhere
        { cr: "HIST-981", wave: "24" }, // orphan: no release anywhere
        { cr: "HIST-990", wave: "25", release: "0.9.9" },
      ]);
      proposeRelease(store, key, agent, "0.9.8", 1_860_000_000);
      proposeRelease(store, key, agent, "0.9.9", 1_865_000_000);
      // CR-CRU-177: this test is about orphan PLACEMENT, not listing — 0.9.9
      // needs a completed CR of its own to stay listed (orchestrator ruling
      // 2026-10-09), so its "no wave 24 here" assertion stays observable.
      mergeCr(store, key, "HIST-990", "nine90a");

      shipReleaseAt(store, key, agent, day + 1 * HOUR, {
        label: "0.9.6",
        commit: "nine60a",
        crs: ["HIST-960"],
      });
      // closes AFTER 0.9.6 ships, BEFORE 0.9.7 ships -> lands under 0.9.7.
      mergeCrAt(store, key, "HIST-980", "orphan980a", day + 2 * HOUR);
      shipReleaseAt(store, key, agent, day + 3 * HOUR, {
        label: "0.9.7",
        commit: "nine70a",
        crs: ["HIST-970"],
      });
      // closes AFTER every ship -> lands under the LOWEST unshipped release
      // (0.9.8, not 0.9.9).
      mergeCrAt(store, key, "HIST-981", "orphan981a", day + 4 * HOUR);

      setSystemTime();
      const res = await getHistory(handle, key);
      expect(res.status).toBe(200);
      const body = (await res.json()) as HistoryResponse;

      const row097 = releaseOf(body, "0.9.7");
      expect(row097.crCount).toBe(2);
      expect(waveOf(row097, "24")?.crs).toEqual(["HIST-980"]);
      expect(waveOf(row097, "23")?.crs).toEqual(["HIST-970"]);

      const row096 = releaseOf(body, "0.9.6");
      expect(waveOf(row096, "24")).toBeUndefined();
      expect(row096.crCount).toBe(1);

      const row098 = releaseOf(body, "0.9.8");
      expect(row098.crCount).toBe(1);
      expect(waveOf(row098, "24")?.crs).toEqual(["HIST-981"]);

      const row099 = releaseOf(body, "0.9.9");
      expect(waveOf(row099, "24")).toBeUndefined();
    });

    test("a release-less wave (several CRs, none naming any release) is placed as a WHOLE, all its CRs landing under the SAME release", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = seedProject(handle.store, "history-release-less-wave");
      const store = handle.store;
      const agent = "fixture-orchestrator";
      const day = Date.UTC(2026, 8, 21, 0, 0, 0);
      const HOUR = 3_600_000;
      const MIN = 60_000;

      seedQueue(store, key, [
        { cr: "HIST-460", wave: "7" },
        { cr: "HIST-470", wave: "7" },
        { cr: "HIST-480", wave: "26" }, // orphan wave member 1
        { cr: "HIST-481", wave: "26" }, // orphan wave member 2
        { cr: "HIST-482", wave: "26" }, // orphan wave member 3
      ]);

      shipReleaseAt(store, key, agent, day + 1 * HOUR, {
        label: "0.46.0",
        commit: "fourtysix0a",
        crs: ["HIST-460"],
      });
      mergeCrAt(store, key, "HIST-480", "orphan480a", day + 2 * HOUR);
      mergeCrAt(store, key, "HIST-481", "orphan481a", day + 2 * HOUR + 1 * MIN);
      mergeCrAt(store, key, "HIST-482", "orphan482a", day + 2 * HOUR + 2 * MIN);
      shipReleaseAt(store, key, agent, day + 3 * HOUR, {
        label: "0.47.0",
        commit: "fourtyseven0a",
        crs: ["HIST-470"],
      });

      setSystemTime();
      const res = await getHistory(handle, key);
      expect(res.status).toBe(200);
      const body = (await res.json()) as HistoryResponse;

      const next = releaseOf(body, "0.47.0");
      expect(waveOf(next, "26")?.crs.sort()).toEqual(["HIST-480", "HIST-481", "HIST-482"]);
      expect(next.crCount).toBe(4);

      const prev = releaseOf(body, "0.46.0");
      expect(waveOf(prev, "26")).toBeUndefined();
      expect(prev.crCount).toBe(1);
    });
  });

  // \u2500\u2500 a runs-only inferred wave: no plan, no queue entry \u2500 its RUNS carry a
  //    wave that itself names no release; placed by its first run's time, the
  //    SAME timeline fallback a gate naming neither release nor wave already
  //    gets (user ruling 2026-10-09) \u2500\u2500

  describe("a runs-only inferred wave whose wave itself names no release (user ruling 2026-10-09)", () => {
    let handle: ServerHandle | undefined;

    afterEach(() => {
      handle?.stop();
      handle = undefined;
      setSystemTime();
    });

    test("a gate run naming a wave NO queue entry ever assigns to any release is NOT dropped \u2014 it lands under the first release that shipped at or after it, else the lowest unshipped release, by the run's OWN time", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = seedProject(handle.store, "history-runs-only-wave-no-release");
      const store = handle.store;
      const agent = "fixture-orchestrator";
      const day = Date.UTC(2026, 9, 1, 0, 0, 0);
      const HOUR = 3_600_000;

      seedQueue(store, key, [
        { cr: "HIST-500", wave: "27" },
        { cr: "HIST-510", wave: "28" },
      ]);

      shipReleaseAt(store, key, agent, day + 1 * HOUR, {
        label: "0.50.0",
        commit: "five0a",
        crs: ["HIST-500"],
      });
      // wave "99": no queue entry EVER names it, so releaseOfWave resolves
      // nothing for it \u2014 today's code silently DROPS this run from every
      // release's gateRuns. It must instead fall back to the ship timeline,
      // by ITS OWN timestamp: sealed after 0.50.0 shipped, before 0.51.0 did.
      const betweenShips = postGateAt(
        store,
        key,
        agent,
        day + 2 * HOUR,
        { intent: "wave 99 no-mistakes gate", outcome: "passed", steps: [{ name: "review", status: "passed" }] },
        { context: { wave: "99" } },
      );
      shipReleaseAt(store, key, agent, day + 3 * HOUR, {
        label: "0.51.0",
        commit: "five1a",
        crs: ["HIST-510"],
      });

      proposeRelease(store, key, agent, "0.52.0", 1_870_000_000);
      proposeRelease(store, key, agent, "0.53.0", 1_875_000_000);
      // CR-CRU-177: this test is about gate PLACEMENT, not listing \u2014 0.52.0
      // needs a completed CR of its own to stay listed (orchestrator ruling
      // 2026-10-09); 0.53.0 stays CR-less and gate-less on purpose, proving
      // it is NOT where the fallback gate lands.
      seedQueue(store, key, [{ cr: "HIST-520", wave: "40", release: "0.52.0" }]);
      mergeCr(store, key, "HIST-520", "fivetwenty0a");
      // wave "100": same story, sealed AFTER every ship -> lowest unshipped.
      const afterAllShips = postGateAt(
        store,
        key,
        agent,
        day + 4 * HOUR,
        { intent: "wave 100 no-mistakes gate", outcome: "failed", steps: [{ name: "test", status: "failed" }] },
        { context: { wave: "100" } },
      );

      setSystemTime();
      const res = await getHistory(handle, key);
      expect(res.status).toBe(200);
      const body = (await res.json()) as HistoryResponse;

      const row051 = workflowOf(releaseOf(body, "0.51.0"), "0.51.0").gateRuns;
      expect(row051.map((r) => r.eventId)).toEqual([betweenShips]);
      expect(row051[0]!.outcome).toBe("passed");
      expect(workflowOf(releaseOf(body, "0.50.0"), "0.50.0").gateRuns).toEqual([]);

      const row052 = workflowOf(releaseOf(body, "0.52.0"), "0.52.0").gateRuns;
      expect(row052.map((r) => r.eventId)).toEqual([afterAllShips]);
      expect(row052[0]!.outcome).toBe("failed");
      expect(row052[0]!.stopStep).toBe("test");
      expect(body.releases.some((r) => r.labels.includes("0.53.0"))).toBe(false);
    });
  });

  // -- withdrawn work: a queued CR declared VOID or SUPERSEDED that never had
  //    a plan belongs to no release, wherever the queue files it ------------

  describe("withdrawn work that never had a plan belongs to no release, even one the queue files it under", () => {
    let handle: ServerHandle | undefined;

    afterEach(() => {
      handle?.stop();
      handle = undefined;
    });

    test("CR-CRU-177 re-pin: a VOID or SUPERSEDED planless CR filed under a release is neither counted nor listed there; one that HAD a plan stays attributed but, never merged, counts as PENDING not completed; a release holding only withdrawn work is not listed", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = seedProject(handle.store, "history-withdrawn-filed-under-release");
      const store = handle.store;
      const agent = "fixture-orchestrator";

      seedQueue(store, key, [
        { cr: "HIST-611", wave: "31", release: "0.9.1" }, // live, merged (completed) \u2014 CR-CRU-177 needs this to keep 0.9.1 listed
        { cr: "HIST-612", wave: "31", release: "0.9.1" }, // VOID, never planned
        { cr: "HIST-613", wave: "31", release: "0.9.1" }, // SUPERSEDED, but had a plan \u2014 never merged, so still pending
        { cr: "HIST-614", wave: "32", release: "0.9.2" }, // VOID, never planned: 0.9.2's only CR
      ]);
      proposeRelease(store, key, agent, "0.9.1", 1_853_000_000);
      proposeRelease(store, key, agent, "0.9.2", 1_854_000_000);
      mergeCr(store, key, "HIST-611", "six110a");
      fileCr(store, key, "HIST-613");
      expect(store.setQueueLifecycle(key, "HIST-612", { state: "VOID", reason: "not happening" })).toEqual({ changed: true });
      expect(store.setQueueLifecycle(key, "HIST-613", { state: "SUPERSEDED", by: "HIST-611" })).toEqual({ changed: true });
      expect(store.setQueueLifecycle(key, "HIST-614", { state: "VOID", reason: "not happening" })).toEqual({ changed: true });

      const res = await getHistory(handle, key);
      expect(res.status).toBe(200);
      const body = (await res.json()) as HistoryResponse;

      const row = releaseOf(body, "0.9.1");
      expect(row.crCount).toBe(1);
      expect(row.pendingCount).toBe(1);
      expect(waveOf(row, "31")?.crs).toEqual(["HIST-611"]);
      expect(waveOf(row, "31")?.crs).not.toContain("HIST-613");
      expect(waveOf(row, "31")?.pendingCount).toBe(1);

      expect(body.releases.some((r) => r.labels.includes("0.9.2"))).toBe(false);
      const listed = body.releases.flatMap((r) => r.waves.flatMap((w) => w.crs));
      expect(listed).not.toContain("HIST-612");
      expect(listed).not.toContain("HIST-614");
    });
  });

  // -- a gate naming a version no release record carries falls back by the
  //    timeline rule ---------------------------------------------------------

  describe("a gate naming a version that has no release record", () => {
    let handle: ServerHandle | undefined;

    afterEach(() => {
      handle?.stop();
      handle = undefined;
      setSystemTime();
    });

    test("belongs to the first release that shipped at or after it; one sealed after every ship belongs to the lowest unshipped release; the version it names gets no row of its own", async () => {
      handle = startServer({ port: 0, dbPath: ":memory:" });
      const key = seedProject(handle.store, "history-gate-version-without-record");
      const store = handle.store;
      const agent = "fixture-orchestrator";
      const day = Date.UTC(2026, 9, 2, 0, 0, 0);
      const HOUR = 3_600_000;

      seedQueue(store, key, [
        { cr: "HIST-621", wave: "33" },
        { cr: "HIST-622", wave: "34" },
        { cr: "HIST-623", wave: "35", release: "0.62.4" },
        { cr: "HIST-624", wave: "36", release: "0.62.6" },
      ]);
      proposeRelease(store, key, agent, "0.62.4", 1_880_000_000);
      proposeRelease(store, key, agent, "0.62.6", 1_885_000_000);
      // CR-CRU-177: this test is about gate PLACEMENT, not listing \u2014 both
      // 0.62.4 (which also gets `afterShips` attributed by timeline
      // fallback, and would stay listed on that alone) and 0.62.6 (which
      // gets no gate at all, so it needs its OWN completed CR to stay
      // listed and prove the negative gateRuns==[] check) gain a completed
      // CR (orchestrator ruling 2026-10-09).
      mergeCr(store, key, "HIST-623", "six230a");
      mergeCr(store, key, "HIST-624", "six240a");

      shipReleaseAt(store, key, agent, day + 1 * HOUR, {
        label: "0.62.1",
        commit: "six21a",
        crs: ["HIST-621"],
      });
      // names 0.62.15, which no record carries; sealed after 0.62.1 shipped,
      // before 0.62.2 did: it belongs to 0.62.2.
      const betweenShips = postGateAt(
        store,
        key,
        agent,
        day + 2 * HOUR,
        { intent: "release gate", outcome: "passed", steps: [{ name: "review", status: "passed" }] },
        { version: "0.62.15" },
      );
      shipReleaseAt(store, key, agent, day + 3 * HOUR, {
        label: "0.62.2",
        commit: "six22a",
        crs: ["HIST-622"],
      });
      // names 0.62.25, which no record carries; sealed after every ship: it
      // belongs to the lowest unshipped release, 0.62.4 (not 0.62.6).
      const afterShips = postGateAt(
        store,
        key,
        agent,
        day + 4 * HOUR,
        { intent: "release gate", outcome: "failed", steps: [{ name: "test", status: "failed" }] },
        { version: "0.62.25" },
      );

      setSystemTime();
      const res = await getHistory(handle, key);
      expect(res.status).toBe(200);
      const body = (await res.json()) as HistoryResponse;

      expect(workflowOf(releaseOf(body, "0.62.2"), "0.62.2").gateRuns.map((r) => r.eventId)).toEqual([betweenShips]);
      expect(workflowOf(releaseOf(body, "0.62.1"), "0.62.1").gateRuns).toEqual([]);
      const lowest = workflowOf(releaseOf(body, "0.62.4"), "0.62.4").gateRuns;
      expect(lowest.map((r) => r.eventId)).toEqual([afterShips]);
      expect(lowest[0]!.stopStep).toBe("test");
      expect(workflowOf(releaseOf(body, "0.62.6"), "0.62.6").gateRuns).toEqual([]);
      expect(body.releases.some((r) => r.labels.includes("0.62.15") || r.labels.includes("0.62.25"))).toBe(false);
    });
  });
});
