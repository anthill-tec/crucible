// A release records WHEN it shipped and WHAT it shipped — release PROVENANCE
// (RED).
//
// Spec: docs/changes/CR-CRU-080-release-ceremony-cannot-report.md §S4 +
// AC7/AC8/AC9/AC10/AC11.
//
//   §S4  the release milestone carries two additions in its payload (the
//        events table stores payload verbatim, so NO column and NO migration —
//        SCHEMA_VERSION stays 7):
//          `releasedAt` — the tag's own commit date (`git log -1 --format=%ct
//                         <tag>`), i.e. when the release actually SHIPPED,
//                         distinct from the event `timestamp`, which is when
//                         it was RECORDED;
//          `crs`        — the CR ids the release shipped, from the tag range
//                         (`git log <prev-tag>..<tag>`, CR ids matched in
//                         MERGE subjects) intersected with the registered
//                         queue.
//        `releaseBrief` exposes both on `GET …/releases`, and consumers order
//        releases by `releasedAt`, never by ingest `timestamp`.
//
// WHY THIS FILE EXISTS. CR-CRU-077 (the roadmap execution DAG) is blocked
// because nothing links a CR to a release and the one date we keep is the
// wrong one: the three real releases all say 2026-08-21 13:45 (the backfill's
// ingest minute) while their tags are 2026-08-19/08-20, and all 62 closed
// plans predate every release timestamp — so a `closedAt < releaseTs` rule
// attributes the entire backlog to 0.1.0. Commit ancestry is the correct rule
// but needs git, which neither the browser nor the server has. The ceremony
// does: it stands in the repo, at the moment the answers are knowable.
//
// TECHNIQUE — two layers, each driving the REAL path for the contract it owns:
//
//   A. THE CEREMONY (AC7/AC8/AC10/AC11) runs `scripts/release.sh
//      backfill-releases` against a REAL throwaway git repo whose commits and
//      tags are built with pinned GIT_AUTHOR_DATE/GIT_COMMITTER_DATE, through
//      the REAL `clients/python-crucible.py`, against a LIVE in-process
//      server. Real git is deliberate and load-bearing: a stub `git` (the
//      harness tests/release-backfill.test.ts and
//      tests/release-reporting-live.test.ts use) cannot answer `git log -1
//      --format=%ct <tag>` or a `<prev-tag>..<tag>` range, and a stub that
//      merely echoes canned answers would prove the ceremony asked rather
//      than that it computed. The fixture's tag dates are ~a MONTH before
//      "now", so `releasedAt` and the ingest `timestamp` can never coincide.
//
//   B. THE WIRE (AC9) posts releases straight at `POST /api/v2/milestones` —
//      the server's own production entry — because AC9 is a SERVER contract
//      (`handleMilestones` must carry the two payload fields through, and
//      `releaseBrief` must expose them and order by `releasedAt`). Recording
//      the NEWEST tag FIRST makes ship order the exact REVERSE of ingest
//      order, so the ordering assertion cannot pass by accident; the test
//      asserts the returned ingest timestamps ASCEND, which is precisely what
//      a `timestamp DESC` sort could never produce.
//
// SAFETY: the server is in-process on an OS-assigned port (`port: 0`) over a
// per-test `mktemp` db — never port 3849, never data/crucible.db — and is
// stopped through its own handle. The git fixture lives under `mktemp`; no
// real remote, no push, no repo mutation.
//
// RED expectation (measured against c988de3, C1 GREEN):
//   * `handleMilestones` (src/v2.ts:1147) passes ONLY label/commit/context
//     into `recordMilestoneEvent`, so unknown body fields are silently
//     dropped; `releaseBrief` (src/v2.ts:1617) emits only {version, commit,
//     timestamp}. Every `releasedAt`/`crs` assertion below therefore fails on
//     `undefined` — the missing contract, not a broken fixture.
//   * `emit_release_milestone` (scripts/release.sh:391) computes neither the
//     tag date nor the CR set, so the ceremony has nothing to send.
//   * `Store.listReleases` (src/store.ts:1994) orders by ingest `timestamp
//     DESC`, so the AC9 ordering assertion fails with the ship order reversed.
// Pre-existing coverage that must keep passing: tests/releases.test.ts AC4-a
// (releases with NO `releasedAt` stay newest-INGEST-first).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const RELEASE_SH = join(REPO_ROOT, "scripts", "release.sh");

/** The identity the ceremony declares (CR-CRU-080 §S1), registered live. */
const AGENT_ID = "release-ceremony-1";

/** One shipped release of the fixture repo: the tag, the UTC instant its
 *  release commit is pinned to (so `git log -1 --format=%ct <tag>` is a known
 *  constant), and the CR ids that tag's range shipped AND the queue knows. */
interface ShippedFixture {
  readonly version: string;
  /** Epoch SECONDS — the unit `git log -1 --format=%ct` speaks, which §S4
   *  names as the source of `releasedAt`. */
  readonly releasedAt: number;
  readonly crs: readonly string[];
}

/** 2026-07 dates: ~a month before "now", so `releasedAt` can never be mistaken
 *  for (or coincide with) the ingest clock. */
const SHIPPED: readonly ShippedFixture[] = [
  {
    version: "0.1.0",
    releasedAt: Date.UTC(2026, 6, 10, 12, 0, 0) / 1000,
    crs: ["CR-CRU-041", "CR-CRU-042"],
  },
  {
    version: "0.1.1",
    releasedAt: Date.UTC(2026, 6, 15, 9, 30, 0) / 1000,
    // CR-CRU-055 is merged in this range but is NOT in the registered queue.
    crs: ["CR-CRU-050"],
  },
  {
    version: "0.1.2",
    releasedAt: Date.UTC(2026, 6, 20, 16, 45, 0) / 1000,
    crs: ["CR-CRU-060", "CR-CRU-061"],
  },
];

/** In the range 0.1.0..0.1.1 but never filed: the queue intersection drops it. */
const UNQUEUED_CR = "CR-CRU-055";

/** Filed in the queue but merged AFTER the newest tag: no release shipped it. */
const AFTER_LAST_TAG_CR = "CR-CRU-099";

/** Every CR the project's queue holds — the intersection's right-hand side.
 *  UNQUEUED_CR is deliberately absent; AFTER_LAST_TAG_CR deliberately present,
 *  so its exclusion is provably about the tag RANGE and not about the queue. */
const QUEUED_CRS = [
  "CR-CRU-041",
  "CR-CRU-042",
  "CR-CRU-050",
  "CR-CRU-060",
  "CR-CRU-061",
  AFTER_LAST_TAG_CR,
];

interface ReleaseBrief {
  version?: string;
  commit?: string;
  timestamp: number;
  releasedAt?: number;
  crs?: string[];
}

interface ReleasesResponse {
  ok: boolean;
  releases: ReleaseBrief[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The ambient environment, with git's user/system config neutralised so the
 *  fixture's history is independent of whoever runs the suite (a global
 *  `commit.gpgsign` would otherwise break every fixture commit). */
function gitEnv(date?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  if (date !== undefined) {
    env.GIT_AUTHOR_DATE = date;
    env.GIT_COMMITTER_DATE = date;
  }
  return env;
}

/** Run git in the fixture, failing loudly: a broken fixture must never read as
 *  a RED on the contract. */
function git(repo: string, args: string[], date?: string): string {
  const r = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: repo,
    env: gitEnv(date),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    throw new Error(`fixture git ${args.join(" ")} failed: ${new TextDecoder().decode(r.stderr)}`);
  }
  return new TextDecoder().decode(r.stdout).trim();
}

/** A REAL merge commit whose SUBJECT carries the CR id — the shape CR-CRU-080
 *  §S4 matched against. The merged branch's own commit subject deliberately
 *  carries NO CR id, so a `--merges`-filtered scan and an unfiltered one agree;
 *  the fixture does not silently prefer one implementation.
 *
 *  Returns the MERGE COMMIT's sha — the value the project records as
 *  `plan.merge.commit` when the CR closes, and therefore the left-hand side of
 *  CR-CRU-081 §S1's ancestry probe.
 */
function mergeCr(repo: string, cr: string, slug: string, date: string): string {
  const branch = `feature/${cr}-${slug}`;
  git(repo, ["checkout", "-q", "-b", branch]);
  writeFileSync(join(repo, `${cr}.txt`), `work for ${cr}\n`);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "feat: work on the thing"], date);
  git(repo, ["checkout", "-q", "master"]);
  git(repo, ["merge", "-q", "--no-ff", "-m", `Merge branch '${branch}' into develop`, branch], date);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** A release commit + its bare-SemVer tag. The tag is lightweight, so
 *  `git log -1 --format=%ct <tag>` is exactly this commit's pinned date. */
function tagRelease(repo: string, version: string, date: string): void {
  writeFileSync(join(repo, "CHANGELOG.md"), `# ${version}\n`);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", `chore(release): ${version}`], date);
  git(repo, ["tag", version]);
}

/**
 * A throwaway REAL git repo carrying three shipped releases with pinned dates:
 *
 *   chore: init                                   2026-07-01
 *   Merge …CR-CRU-041…                            2026-07-03
 *   Merge …CR-CRU-042…                            2026-07-04
 *   chore(release): 0.1.0            tag 0.1.0    2026-07-10 12:00Z
 *   Merge …CR-CRU-050…                            2026-07-12
 *   Merge …CR-CRU-055…  (never queued)            2026-07-13
 *   chore(release): 0.1.1            tag 0.1.1    2026-07-15 09:30Z
 *   Merge …CR-CRU-060…                            2026-07-18
 *   Merge …CR-CRU-061…                            2026-07-19
 *   chore(release): 0.1.2            tag 0.1.2    2026-07-20 16:45Z
 *   Merge …CR-CRU-099…  (queued, unreleased)      2026-07-25
 *
 * It doubles as the ceremony's world: `repo_root` resolves here (real `git
 * rev-parse --show-toplevel`), `clients/` is a symlink to the REAL repo
 * clients, and `.env` names the live project.
 *
 * Returns the repo path AND the cr→merge-sha map its history produced, so the
 * live project can be seeded with the CLOSED PLANS that carry those shas
 * (CR-CRU-081 §S1) — the record ancestry resolves provenance from.
 */
function buildFixtureRepo(): { repo: string; mergeShas: Map<string, string> } {
  const repo = mkdtempSync(join(tmpdir(), "release-provenance-repo-"));
  git(repo, ["init", "-q", "-b", "master"]);
  git(repo, ["config", "user.name", "Release Fixture"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["config", "gitflow.prefix.versiontag", ""]);

  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "chore: init"], "2026-07-01T10:00:00Z");

  const mergeShas = new Map<string, string>();
  mergeShas.set("CR-CRU-041", mergeCr(repo, "CR-CRU-041", "alpha", "2026-07-03T10:00:00Z"));
  mergeShas.set("CR-CRU-042", mergeCr(repo, "CR-CRU-042", "beta", "2026-07-04T10:00:00Z"));
  tagRelease(repo, "0.1.0", "2026-07-10T12:00:00Z");

  mergeShas.set("CR-CRU-050", mergeCr(repo, "CR-CRU-050", "gamma", "2026-07-12T10:00:00Z"));
  mergeShas.set(UNQUEUED_CR, mergeCr(repo, UNQUEUED_CR, "unqueued", "2026-07-13T10:00:00Z"));
  tagRelease(repo, "0.1.1", "2026-07-15T09:30:00Z");

  mergeShas.set("CR-CRU-060", mergeCr(repo, "CR-CRU-060", "delta", "2026-07-18T10:00:00Z"));
  mergeShas.set("CR-CRU-061", mergeCr(repo, "CR-CRU-061", "epsilon", "2026-07-19T10:00:00Z"));
  tagRelease(repo, "0.1.2", "2026-07-20T16:45:00Z");

  mergeShas.set(
    AFTER_LAST_TAG_CR,
    mergeCr(repo, AFTER_LAST_TAG_CR, "after", "2026-07-25T10:00:00Z"),
  );

  // The ceremony's world, alongside the history.
  writeFileSync(join(repo, "package.json"), `{\n  "name": "crucible",\n  "version": "0.1.2"\n}\n`);
  symlinkSync(join(REPO_ROOT, "clients"), join(repo, "clients"));
  return { repo, mergeShas };
}

const sortedCrs = (crs: string[] | undefined): string[] => [...(crs ?? [])].sort();

const byVersion = (releases: ReleaseBrief[]): Map<string, ReleaseBrief> =>
  new Map(releases.map((r) => [r.version ?? "", r]));

/** POST/PATCH JSON at a live server. Module-level because both sections drive
 *  the same real HTTP surfaces: a project, its queue, and the CLOSED PLANS
 *  whose `merge.commit` is CR-CRU-081 §S1's ancestry input. */
async function postJson(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function patchJson(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * The project's own record of WHERE a CR landed, written through the REAL plan
 * flow the `cr-close` verb drives: file a one-cycle plan, seal the cycle
 * (pending → active → done, the only order `closePlan` accepts), then close the
 * plan — with `merge: {commit}` when the landing sha is known, and WITHOUT it
 * when it is not (the unplaceable case, CR-CRU-081 §S2/AC4).
 *
 * Sequential by construction: each plan closes before the next is filed, so the
 * project never holds two active cycles.
 */
async function seedClosedPlan(
  base: string,
  key: string,
  cr: string,
  commit: string | null,
): Promise<void> {
  const plans = `/api/v2/projects/${key}/plans`;
  const filed = await postJson(base, plans, { agentId: AGENT_ID, cr, cycles: [{ label: "solo" }] });
  expect(filed.status).toBe(201);
  const plan = (await filed.json()) as { planId: number; cycles: Array<{ id: number }> };
  const cyclePath = `${plans}/${plan.planId}/cycles/${plan.cycles[0]!.id}`;
  for (const status of ["active", "done"]) {
    const moved = await patchJson(base, cyclePath, { agentId: AGENT_ID, status });
    expect(moved.status).toBe(200);
  }
  const closed = await patchJson(base, `${plans}/${plan.planId}`, {
    agentId: AGENT_ID,
    status: "closed",
    ...(commit === null ? {} : { merge: { commit } }),
  });
  expect(closed.status).toBe(200);
}

async function listReleases(base: string, key: string): Promise<ReleaseBrief[]> {
  const res = await fetch(`${base}/api/v2/projects/${key}/releases`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as ReleasesResponse;
  return body.releases;
}

/**
 * Runs the REAL ceremony against the REAL fixture repo, the REAL client and
 * the LIVE server. ASYNC on purpose (measured in
 * tests/release-reporting-live.test.ts): `Bun.spawnSync` blocks the event
 * loop, so the in-process server could never answer the client's POST.
 */
async function runBackfill(
  repo: string,
  base: string,
): Promise<{ exitCode: number; output: string }> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: repo,
    SHELL: "/bin/sh",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    CRUCIBLE_AGENT: AGENT_ID,
    CRUCIBLE_URL: base,
    PY_CRUCIBLE_PROJECT_DIR: repo,
  };
  const proc = Bun.spawn({
    cmd: ["bash", RELEASE_SH, "backfill-releases"],
    cwd: repo,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, output: `${stdout}\n${stderr}` };
}

// ---------------------------------------------------------------------------
// A. the ceremony computes provenance from the repo it stands in
// ---------------------------------------------------------------------------

describe("the release ceremony records WHEN a release shipped and WHAT it shipped (CR-CRU-080 §S4)", () => {
  let repo: string;
  let mergeShas: Map<string, string>;
  let handle: ServerHandle | undefined;
  const dbDirs: string[] = [];

  beforeAll(() => {
    ({ repo, mergeShas } = buildFixtureRepo());
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    for (const d of dbDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** In-process server on an OS-assigned port over a throwaway on-disk db —
   *  never 3849, never data/crucible.db. Stopped by handle in afterEach. */
  function boot(): string {
    const dir = mkdtempSync(join(tmpdir(), "release-provenance-db-"));
    dbDirs.push(dir);
    handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
    return `http://localhost:${handle.server.port}`;
  }

  /** A project, the ceremony's registered identity, and the REGISTERED QUEUE —
   *  the right-hand side of §S4's intersection. */
  async function seedProject(base: string, name: string): Promise<string> {
    const res = await postJson(base, "/api/v2/projects", { name });
    const body = (await res.json()) as { project: { key: string } };
    const key = body.project.key;

    const reg = await postJson(base, "/api/v2/agents/register", {
      projectKey: key,
      agentId: AGENT_ID,
      role: "ORCHESTRATOR",
    });
    expect(reg.status).toBe(200);

    const queue = await postJson(base, `/api/v2/projects/${key}/queue`, {
      entries: QUEUED_CRS.map((cr) => ({ cr, title: `${cr} work`, wave: "1" })),
    });
    expect(queue.status).toBe(200);

    // CR-CRU-081 §S1 — the CR→merge-sha record ancestry reads. One CLOSED plan
    // per CR the fixture merged, carrying that merge's REAL sha, exactly as
    // `cr-close --commit` writes it. Seeded for UNQUEUED_CR too, so what keeps
    // it out of `crs` stays the QUEUE intersection and never a missing plan.
    for (const [cr, commit] of mergeShas) {
      await seedClosedPlan(base, key, cr, commit);
    }

    // The world's `.env` names THIS project for the real client.
    writeFileSync(join(repo, ".env"), `CRUCIBLE_PROJECT_KEY=${key}\n`);
    return key;
  }

  /** One backfilled world: the ceremony has run once, cleanly, and recorded
   *  all three shipped releases. */
  async function backfilled(name: string): Promise<{ base: string; key: string; releases: ReleaseBrief[] }> {
    const base = boot();
    const key = await seedProject(base, name);
    const run = await runBackfill(repo, base);
    // The failure channel must be clean: a swallowed report would make every
    // provenance assertion below meaningless.
    expect(run.exitCode).toBe(0);
    expect(run.output).not.toMatch(/agent-identity-required/);
    expect(run.output).not.toMatch(/NOT recorded/);
    const releases = await listReleases(base, key);
    expect(releases.length).toBe(3);
    return { base, key, releases };
  }

  // ── AC7 — releasedAt is the TAG's date, never the ingest clock ───────────

  test(
    "AC7 every backfilled release carries releasedAt equal to its own tag's commit date " +
      "(git log -1 --format=%ct), so 0.1.0/0.1.1/0.1.2 report 2026-07-10, 2026-07-15 and 2026-07-20",
    async () => {
      const { releases } = await backfilled("provenance-released-at");
      const found = byVersion(releases);

      for (const shipped of SHIPPED) {
        const rel = found.get(shipped.version);
        expect(rel).toBeDefined();
        // The fixture's own history is the authority (§S4 names %ct)...
        const fromGit = Number(git(repo, ["log", "-1", "--format=%ct", shipped.version]));
        expect(fromGit).toBe(shipped.releasedAt);
        // ...and the recorded release must carry exactly that.
        expect(rel!.releasedAt).toBe(fromGit);
      }
    },
  );

  test(
    "AC7 releasedAt is provably NOT the ingest time: one backfill run records all three " +
      "releases within seconds of each other, yet their releasedAt values are the three " +
      "distinct tag dates, each over a month from the ingest clock",
    async () => {
      const { releases } = await backfilled("provenance-not-ingest-time");
      const found = byVersion(releases);

      // The ingest clock: all three recorded inside ONE run, so within a minute.
      const ingest = releases.map((r) => r.timestamp);
      expect(Math.max(...ingest) - Math.min(...ingest)).toBeLessThan(60_000);

      for (const shipped of SHIPPED) {
        const rel = found.get(shipped.version)!;
        expect(rel.releasedAt).toBe(shipped.releasedAt);
        // Days apart from when it was RECORDED — the two can never coincide,
        // which is the whole point (the real backfill stamped 2026-08-21 13:45
        // on tags from 2026-08-19/08-20).
        expect(Math.abs(rel.timestamp - rel.releasedAt! * 1000)).toBeGreaterThan(7 * DAY_MS);
      }
      // Three DISTINCT ship dates from a single ingest minute.
      expect(new Set(SHIPPED.map((s) => found.get(s.version)!.releasedAt)).size).toBe(3);
    },
  );

  // ── AC8 — crs is the tag range ∩ the registered queue ───────────────────

  test(
    "AC8 each release carries the CR ids merged in its OWN tag range, intersected with the " +
      "registered queue: 0.1.0 ships CR-CRU-041+CR-CRU-042, 0.1.1 ships CR-CRU-050, " +
      "0.1.2 ships CR-CRU-060+CR-CRU-061",
    async () => {
      const { releases } = await backfilled("provenance-crs");
      const found = byVersion(releases);

      for (const shipped of SHIPPED) {
        const rel = found.get(shipped.version);
        expect(rel).toBeDefined();
        expect(Array.isArray(rel!.crs)).toBe(true);
        // POSITIVE, exact and BOUND: the set, not "at least these".
        expect(sortedCrs(rel!.crs)).toEqual([...shipped.crs].sort());
        expect(rel!.crs!.length).toBeGreaterThan(0);
      }
    },
  );

  test(
    "AC8 a CR merged AFTER the newest tag (CR-CRU-099, filed in the queue) is in no release's " +
      "crs — a release describes what it shipped, not what came later",
    async () => {
      const { releases } = await backfilled("provenance-crs-after-tag");

      // Guard: the contract must EXIST, or the exclusion below is vacuous.
      for (const rel of releases) {
        expect(Array.isArray(rel.crs)).toBe(true);
        expect(rel.crs!.length).toBeGreaterThan(0);
      }
      for (const rel of releases) {
        expect(rel.crs).not.toContain(AFTER_LAST_TAG_CR);
      }
    },
  );

  test(
    "AC8 a CR id merged in a tag's range but ABSENT from the registered queue (CR-CRU-055) is " +
      "excluded, so crs is the intersection and not the raw git scan",
    async () => {
      const { releases } = await backfilled("provenance-crs-intersection");
      const found = byVersion(releases);

      const target = found.get("0.1.1")!;
      // Guard: the contract must EXIST first.
      expect(Array.isArray(target.crs)).toBe(true);
      expect(target.crs).toContain("CR-CRU-050");
      // The unqueued CR is in the SAME range and must not appear anywhere.
      for (const rel of releases) {
        expect(rel.crs).not.toContain(UNQUEUED_CR);
      }
    },
  );

  // ── AC10 — the association is a PARTITION, not an overlap ───────────────

  test(
    "AC10 the crs sets are pairwise disjoint — each CR belongs to the EARLIEST tag containing " +
      "it, so CR-CRU-041 appears in 0.1.0 alone and never again in 0.1.1 or 0.1.2",
    async () => {
      const { releases } = await backfilled("provenance-partition");
      const found = byVersion(releases);

      // Guard: every release must actually carry a set.
      for (const rel of releases) {
        expect(Array.isArray(rel.crs)).toBe(true);
        expect(rel.crs!.length).toBeGreaterThan(0);
      }

      // A partition: the union's size equals the sum of the parts.
      const all = releases.flatMap((r) => r.crs ?? []);
      expect(new Set(all).size).toBe(all.length);

      // And the naive "everything up to this tag" implementation is refused
      // explicitly: an earlier release's CRs must not reappear later.
      expect(found.get("0.1.0")!.crs).toContain("CR-CRU-041");
      expect(found.get("0.1.1")!.crs).not.toContain("CR-CRU-041");
      expect(found.get("0.1.2")!.crs).not.toContain("CR-CRU-041");
      expect(found.get("0.1.2")!.crs).not.toContain("CR-CRU-050");
    },
  );

  // ── AC11 — a replayed backfill reports the identical provenance ──────────

  test(
    "AC11 re-running backfill-releases leaves three releases whose releasedAt and crs are " +
      "identical to the first run's, so provenance composes with the §S3 dedup replay",
    async () => {
      const base = boot();
      const key = await seedProject(base, "provenance-idempotent");

      const first = await runBackfill(repo, base);
      expect(first.exitCode).toBe(0);
      const before = await listReleases(base, key);
      expect(before.length).toBe(3);

      const second = await runBackfill(repo, base);
      expect(second.exitCode).toBe(0);
      const after = await listReleases(base, key);
      // BOUND: still three — six would be the un-deduped replay.
      expect(after.length).toBe(3);

      // Guard: the provenance must EXIST, or "identical" is two undefineds.
      const firstRun = byVersion(before);
      for (const rel of after) {
        expect(typeof rel.releasedAt).toBe("number");
        expect(Array.isArray(rel.crs)).toBe(true);
        const prior = firstRun.get(rel.version ?? "");
        expect(prior).toBeDefined();
        expect(rel.releasedAt).toBe(prior!.releasedAt);
        expect(sortedCrs(rel.crs)).toEqual(sortedCrs(prior!.crs));
      }
      // And it is still the tags' own dates, not the second run's clock.
      const found = byVersion(after);
      for (const shipped of SHIPPED) {
        expect(found.get(shipped.version)!.releasedAt).toBe(shipped.releasedAt);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// B. the wire: GET …/releases exposes provenance and orders by SHIP date
// ---------------------------------------------------------------------------

describe("GET …/releases exposes releasedAt + crs and orders releases by ship date (CR-CRU-080 §S4/AC9)", () => {
  let handle: ServerHandle | undefined;
  const dbDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    for (const d of dbDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function boot(): void {
    const dir = mkdtempSync(join(tmpdir(), "release-provenance-wire-db-"));
    dbDirs.push(dir);
    handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`http://localhost:${handle!.server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function createProject(name: string): Promise<string> {
    const res = await postJson("/api/v2/projects", { name });
    const body = (await res.json()) as { project: { key: string } };
    const key = body.project.key;
    const reg = await postJson("/api/v2/agents/register", {
      projectKey: key,
      agentId: AGENT_ID,
      role: "ORCHESTRATOR",
    });
    expect(reg.status).toBe(200);
    return key;
  }

  /** The §S4 payload the ceremony sends: the release milestone plus its two
   *  provenance fields. */
  async function postRelease(
    key: string,
    version: string,
    commit: string,
    releasedAt: number,
    crs: readonly string[],
  ): Promise<Response> {
    return postJson("/api/v2/milestones", {
      projectKey: key,
      agentId: AGENT_ID,
      type: "release",
      label: version,
      commit,
      releasedAt,
      crs,
    });
  }

  async function listReleases(key: string): Promise<ReleaseBrief[]> {
    const res = await fetch(`http://localhost:${handle!.server.port}/api/v2/projects/${key}/releases`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReleasesResponse;
    return body.releases;
  }

  test(
    "AC9 a release recorded with releasedAt and crs comes back carrying BOTH verbatim, " +
      "alongside (and distinct from) its ingest timestamp",
    async () => {
      boot();
      const key = await createProject("wire-exposes-provenance");
      const shipped = SHIPPED[2]!;

      expect((await postRelease(key, shipped.version, "ccc0003", shipped.releasedAt, shipped.crs)).status).toBe(201);

      const releases = await listReleases(key);
      expect(releases.length).toBe(1);
      const rel = releases[0]!;
      expect(rel.version).toBe(shipped.version);
      expect(rel.releasedAt).toBe(shipped.releasedAt);
      expect(sortedCrs(rel.crs)).toEqual([...shipped.crs].sort());
      // The ingest timestamp survives as its own, different, fact.
      expect(typeof rel.timestamp).toBe("number");
      expect(rel.timestamp).not.toBe(shipped.releasedAt);
      expect(Math.abs(rel.timestamp - shipped.releasedAt * 1000)).toBeGreaterThan(7 * DAY_MS);
    },
  );

  test(
    "AC9 releases sort by releasedAt (ship order) and NOT by ingest timestamp: recorded " +
      "newest-tag-first, the list returns 0.1.2, 0.1.1, 0.1.0 while its ingest timestamps ASCEND",
    async () => {
      boot();
      const key = await createProject("wire-orders-by-released-at");

      // Recorded NEWEST ship date FIRST, so ingest order is the exact REVERSE
      // of ship order — an ingest-`timestamp DESC` sort cannot fake this.
      const newestFirst = [...SHIPPED].reverse();
      for (const [index, shipped] of newestFirst.entries()) {
        const res = await postRelease(key, shipped.version, `sha000${index}`, shipped.releasedAt, shipped.crs);
        expect(res.status).toBe(201);
        // A REAL 8ms delay, deliberately: the ingest timestamp is stamped by
        // the SERVER's own `Date.now()` inside its request handler, so no fake
        // timer can separate two posts without falsifying the very clock under
        // test. 8ms only makes the ms-resolution stamps distinct, so the
        // ordering claim below cannot pass by stable-sort accident (same
        // reasoning as tests/releases.test.ts AC4-a).
        await Bun.sleep(8);
      }

      const releases = await listReleases(key);
      expect(releases.length).toBe(3);

      // SHIP order, newest release first.
      expect(releases.map((r) => r.version)).toEqual(["0.1.2", "0.1.1", "0.1.0"]);
      expect(releases.map((r) => r.releasedAt)).toEqual([
        SHIPPED[2]!.releasedAt,
        SHIPPED[1]!.releasedAt,
        SHIPPED[0]!.releasedAt,
      ]);

      // NON-VACUITY: in that same order the INGEST timestamps strictly ASCEND,
      // which the current `timestamp DESC` sort could never produce — the two
      // orders genuinely differ.
      const ingest = releases.map((r) => r.timestamp);
      expect(new Set(ingest).size).toBe(3);
      expect(ingest[0]!).toBeLessThan(ingest[1]!);
      expect(ingest[1]!).toBeLessThan(ingest[2]!);

      // And each row still carries its own shipped CR set.
      expect(sortedCrs(releases[0]!.crs)).toEqual([...SHIPPED[2]!.crs].sort());
      expect(sortedCrs(releases[2]!.crs)).toEqual([...SHIPPED[0]!.crs].sort());
    },
  );
});

// ---------------------------------------------------------------------------
// C. CR-CRU-081 §S1/§S2 — provenance is COMMIT ANCESTRY, never merge-subject
//    text (RED).
//
// Spec: docs/changes/CR-CRU-081-release-provenance-uses-ancestry.md §S1 + §S2
// + AC1/AC2/AC3/AC4/AC6. (§S3, the repair path, is a LATER cycle and is not
// touched here.)
//
//   §S1  a CR belongs to a release when its RECORDED MERGE COMMIT is an
//        ancestor of that tag (`git merge-base --is-ancestor <sha> <tag>`),
//        attributed to the EARLIEST tag satisfying that. The per-CR sha comes
//        from the plan record the project already keeps — `merge: {commit}` on
//        a CLOSED plan, read through the client's existing `plans` verb.
//   §S2  a CR with no recorded merge sha cannot be placed, and is reported as
//        UNPLACEABLE — counted and named — rather than dropped in silence.
//
// WHY THIS SECTION EXISTS. CR-080 §S4 computed `crs` by scanning MERGE-COMMIT
// SUBJECTS (`scripts/release.sh:411` `release_crs`, called at `:457`). Measured
// on this repo, `CR-CRU-021` and `CR-CRU-023` are COMPLETED and shipped in
// 0.1.0, yet `git log --merges --grep` finds neither, so both appear in NO
// release's `crs` — provenance is a strict subset of what shipped, and the
// under-report is indistinguishable from a release that genuinely shipped less.
// Their plan merge shas (`c4c192e`, `b99b547`) ARE ancestors of the `0.1.0`
// tag, so ancestry places exactly what the subject scan drops.
//
// TECHNIQUE — the same two load-bearing choices section A made, aimed at the
// new rule:
//
//   * A SECOND REAL git repo, whose CRs land the three ways a real repo lands
//     them: FAST-FORWARD (no merge commit exists at all), SQUASH (one fresh
//     single-parent commit; the branch commit is not even an ancestor) and
//     `--no-ff` MERGE. The fast-forward and squash CRs are the shape
//     CR-CRU-021/023 have — invisible to any subject scan because there is no
//     merge subject to scan. Each test GUARDS that invisibility against the
//     real history before asserting membership, so a passing assertion can
//     never be the old rule quietly succeeding.
//   * The CR→sha map is seeded as REAL CLOSED PLANS carrying `merge.commit`
//     (`seedClosedPlan`, the exact PATCH `cr-close --commit` issues), so
//     whatever read path the ceremony uses — the `plans` verb — finds the
//     records it is specified to read. One queued CR is closed WITHOUT a merge
//     sha, which is the AC4 unplaceable case.
//
// SAFETY: unchanged from section A — in-process server on `port: 0` over a
// per-test `mktemp` db (never 3849, never data/crucible.db), stopped through
// its own handle; every git fixture under `mktemp`, no remote, no push.
//
// RED expectation (measured against 169f0d1):
//   * `release_crs` (scripts/release.sh:411) greps `git log --merges
//     --format=%s` for CR ids. The fast-forward and squash CRs produce no
//     merge commit, so they are invisible: AC1/AC2/AC3 fail because the
//     release's `crs` is missing them (and in the AC6 no-subject variant `crs`
//     is absent entirely — `emit_release_milestone` omits `--crs` when the scan
//     returns empty).
//   * Nothing anywhere reads plan `merge.commit`, computes ancestry, or counts
//     what it could not place: `grep -c unplaceable scripts/release.sh` is 0,
//     so AC4 fails on a missing output line.
//   * AC6 fails because the two variants' `crs` differ by exactly the CR whose
//     merge subject was rewritten — which IS the defect.
// Every failure above is the unmet contract; each test asserts its fixture
// preconditions (invisibility to the subject scan, and real ancestry via
// `git merge-base --is-ancestor`) FIRST, so a broken fixture reads as a broken
// fixture and never as a RED.

/** The CRs each ancestry-fixture tag shipped. `namedMerge` marks the two that
 *  land behind a `--no-ff` merge whose subject can carry their id — they exist
 *  only so AC6 has a subject to remove. */
const ANCESTRY_SHIPPED: Record<string, readonly string[]> = {
  "0.1.0": ["CR-CRU-141", "CR-CRU-142", "CR-CRU-143"],
  "0.1.1": ["CR-CRU-150"],
  "0.1.2": ["CR-CRU-160", "CR-CRU-161"],
};

/** The CRs that land leaving NO merge commit at all — fast-forward and squash.
 *  This is the CR-CRU-021/CR-CRU-023 shape: shipped, recorded, and invisible to
 *  every subject scan. */
const FF_CR = "CR-CRU-141";
const SQUASH_CR = "CR-CRU-142";

/** Queued and landed by fast-forward AFTER the newest tag: its sha resolves and
 *  is an ancestor of NO tag, so ancestry must place it nowhere — and it is NOT
 *  unplaceable, because its merge sha is recorded. */
const ANCESTRY_UNRELEASED_CR = "CR-CRU-199";

/** Queued, plan CLOSED, and carrying NO merge sha — §S2/AC4's unplaceable CR.
 *  It has no commit in the fixture at all, which is exactly why ancestry cannot
 *  place it and why silence about it would be the bug this CR exists to kill. */
const UNPLACEABLE_CR = "CR-CRU-170";

/** The ancestry project's registered queue: every fixture CR, so nothing is
 *  excluded by the client's queue intersection and every absence below is
 *  provably about ancestry. */
const ANCESTRY_QUEUED_CRS: readonly string[] = [
  ...Object.values(ANCESTRY_SHIPPED).flat(),
  ANCESTRY_UNRELEASED_CR,
  UNPLACEABLE_CR,
];

/** Land `cr` by FAST-FORWARD: master simply advances onto the branch's single
 *  commit, so NO merge commit is created and no subject in the history names
 *  the CR. The recorded landing sha is that commit — an ancestor of every later
 *  tag. */
function landFastForward(repo: string, cr: string, slug: string, date: string): string {
  const branch = `topic/${slug}`;
  git(repo, ["checkout", "-q", "-b", branch]);
  writeFileSync(join(repo, `${cr}.txt`), `work for ${cr}\n`);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "feat: land the work"], date);
  git(repo, ["checkout", "-q", "master"]);
  git(repo, ["merge", "-q", "--ff-only", branch], date);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** Land `cr` by SQUASH: the branch's work is replayed as ONE new
 *  single-parent commit on master, so the branch commit is not an ancestor of
 *  anything and again no merge commit exists. The recorded landing sha is the
 *  squash commit — the sha `cr-close --commit` carries. */
function landSquash(repo: string, cr: string, slug: string, date: string): string {
  const branch = `topic/${slug}`;
  git(repo, ["checkout", "-q", "-b", branch]);
  writeFileSync(join(repo, `${cr}.txt`), `work for ${cr}\n`);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "feat: land the work"], date);
  git(repo, ["checkout", "-q", "master"]);
  git(repo, ["merge", "-q", "--squash", branch]);
  git(repo, ["commit", "-q", "-m", "feat: land the work"], date);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** Land `cr` behind a REAL `--no-ff` merge commit with an EXPLICIT subject —
 *  the one knob AC6 turns. The branch's own commit subject never names the CR,
 *  so `subject` is the only text in the history that can. */
function landNamedMerge(
  repo: string,
  cr: string,
  slug: string,
  date: string,
  subject: string,
): string {
  const branch = `topic/${slug}`;
  git(repo, ["checkout", "-q", "-b", branch]);
  writeFileSync(join(repo, `${cr}.txt`), `work for ${cr}\n`);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "feat: land the work"], date);
  git(repo, ["checkout", "-q", "master"]);
  git(repo, ["merge", "-q", "--no-ff", "-m", subject, branch], date);
  return git(repo, ["rev-parse", "HEAD"]);
}

/**
 * The ancestry fixture — three shipped releases whose CRs land the three real
 * ways, and whose merge SUBJECTS are the single thing that varies:
 *
 *   chore: init                                              2026-07-01
 *   feat: land the work    (fast-forward, CR-CRU-141)        2026-07-03
 *   feat: land the work    (squash,       CR-CRU-142)        2026-07-04
 *   <merge subject>        (--no-ff,      CR-CRU-143)        2026-07-05
 *   chore(release): 0.1.0                       tag 0.1.0    2026-07-10 12:00Z
 *   feat: land the work    (fast-forward, CR-CRU-150)        2026-07-12
 *   chore(release): 0.1.1                       tag 0.1.1    2026-07-15 09:30Z
 *   <merge subject>        (--no-ff,      CR-CRU-160)        2026-07-18
 *   feat: land the work    (squash,       CR-CRU-161)        2026-07-19
 *   chore(release): 0.1.2                       tag 0.1.2    2026-07-20 16:45Z
 *   feat: land the work    (fast-forward, CR-CRU-199)        2026-07-25
 *
 * `namedSubjects` decides whether the two `--no-ff` merge subjects carry their
 * CR id: with it TRUE the old subject scan finds CR-CRU-143 and CR-CRU-160 and
 * nothing else; with it FALSE it finds nothing at all. Ancestry must be
 * indifferent to the difference (AC6).
 *
 * Like `buildFixtureRepo` it doubles as the ceremony's world, and returns the
 * cr→landing-sha map its history produced.
 */
function buildAncestryRepo(namedSubjects: boolean): {
  repo: string;
  mergeShas: Map<string, string>;
} {
  const repo = mkdtempSync(join(tmpdir(), "release-ancestry-repo-"));
  git(repo, ["init", "-q", "-b", "master"]);
  git(repo, ["config", "user.name", "Release Fixture"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["config", "gitflow.prefix.versiontag", ""]);

  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "chore: init"], "2026-07-01T10:00:00Z");

  const subject = (cr: string, slug: string): string =>
    namedSubjects
      ? `Merge branch 'feature/${cr}-${slug}' into develop`
      : `Merge branch 'topic/${slug}' into develop`;

  const mergeShas = new Map<string, string>();
  mergeShas.set(FF_CR, landFastForward(repo, FF_CR, "alpha", "2026-07-03T10:00:00Z"));
  mergeShas.set(SQUASH_CR, landSquash(repo, SQUASH_CR, "beta", "2026-07-04T10:00:00Z"));
  mergeShas.set(
    "CR-CRU-143",
    landNamedMerge(
      repo,
      "CR-CRU-143",
      "gamma",
      "2026-07-05T10:00:00Z",
      subject("CR-CRU-143", "gamma"),
    ),
  );
  tagRelease(repo, "0.1.0", "2026-07-10T12:00:00Z");

  mergeShas.set("CR-CRU-150", landFastForward(repo, "CR-CRU-150", "delta", "2026-07-12T10:00:00Z"));
  tagRelease(repo, "0.1.1", "2026-07-15T09:30:00Z");

  mergeShas.set(
    "CR-CRU-160",
    landNamedMerge(
      repo,
      "CR-CRU-160",
      "epsilon",
      "2026-07-18T10:00:00Z",
      subject("CR-CRU-160", "epsilon"),
    ),
  );
  mergeShas.set("CR-CRU-161", landSquash(repo, "CR-CRU-161", "zeta", "2026-07-19T10:00:00Z"));
  tagRelease(repo, "0.1.2", "2026-07-20T16:45:00Z");

  mergeShas.set(
    ANCESTRY_UNRELEASED_CR,
    landFastForward(repo, ANCESTRY_UNRELEASED_CR, "omega", "2026-07-25T10:00:00Z"),
  );

  writeFileSync(join(repo, "package.json"), `{\n  "name": "crucible",\n  "version": "0.1.2"\n}\n`);
  symlinkSync(join(REPO_ROOT, "clients"), join(repo, "clients"));
  return { repo, mergeShas };
}

/** Every commit SUBJECT reachable from any ref that names `cr` — the whole
 *  surface a text rule could possibly match. Zero means the subject scan is
 *  structurally blind to that CR. */
function subjectsNaming(repo: string, cr: string): string[] {
  return git(repo, ["log", "--all", "--format=%s"])
    .split("\n")
    .filter((s) => s.includes(cr));
}

/** True when `sha` is an ancestor of `tag` — §S1's primitive, run against the
 *  fixture's real history so the ancestry premise is proven, not assumed. */
function isAncestor(repo: string, sha: string, tag: string): boolean {
  const r = Bun.spawnSync({
    cmd: ["git", "merge-base", "--is-ancestor", sha, tag],
    cwd: repo,
    env: gitEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return r.exitCode === 0;
}

describe("release provenance is computed from COMMIT ANCESTRY, not merge-subject text (CR-CRU-081 §S1/§S2)", () => {
  let handle: ServerHandle | undefined;
  const dbDirs: string[] = [];
  const repos: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    for (const d of dbDirs.splice(0)) rmSync(d, { recursive: true, force: true });
    for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  /** In-process server on an OS-assigned port over a throwaway on-disk db —
   *  never 3849, never data/crucible.db. Stopped by handle in afterEach. */
  function boot(): string {
    const dir = mkdtempSync(join(tmpdir(), "release-ancestry-db-"));
    dbDirs.push(dir);
    handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
    return `http://localhost:${handle.server.port}`;
  }

  /** A project, the ceremony's identity, the registered queue, and the CLOSED
   *  PLANS that carry each CR's landing sha — plus `UNPLACEABLE_CR`'s plan,
   *  closed with NO merge sha at all (§S2/AC4). */
  async function seedAncestryProject(
    base: string,
    repo: string,
    mergeShas: Map<string, string>,
    name: string,
  ): Promise<string> {
    const res = await postJson(base, "/api/v2/projects", { name });
    const body = (await res.json()) as { project: { key: string } };
    const key = body.project.key;

    const reg = await postJson(base, "/api/v2/agents/register", {
      projectKey: key,
      agentId: AGENT_ID,
      role: "ORCHESTRATOR",
    });
    expect(reg.status).toBe(200);

    const queue = await postJson(base, `/api/v2/projects/${key}/queue`, {
      entries: ANCESTRY_QUEUED_CRS.map((cr) => ({ cr, title: `${cr} work`, wave: "1" })),
    });
    expect(queue.status).toBe(200);

    for (const [cr, commit] of mergeShas) await seedClosedPlan(base, key, cr, commit);
    await seedClosedPlan(base, key, UNPLACEABLE_CR, null);

    writeFileSync(join(repo, ".env"), `CRUCIBLE_PROJECT_KEY=${key}\n`);
    return key;
  }

  /** One backfilled ancestry world: repo built, project seeded, ceremony run
   *  once cleanly, three releases recorded. */
  async function backfilledAncestry(
    name: string,
    namedSubjects = true,
  ): Promise<{
    repo: string;
    mergeShas: Map<string, string>;
    releases: ReleaseBrief[];
    output: string;
  }> {
    const { repo, mergeShas } = buildAncestryRepo(namedSubjects);
    repos.push(repo);
    const base = boot();
    const key = await seedAncestryProject(base, repo, mergeShas, name);
    const run = await runBackfill(repo, base);
    // The failure channel must be clean, or every assertion below is meaningless.
    expect(run.exitCode).toBe(0);
    expect(run.output).not.toMatch(/agent-identity-required/);
    expect(run.output).not.toMatch(/NOT recorded/);
    const releases = await listReleases(base, key);
    expect(releases.length).toBe(3);
    return { repo, mergeShas, releases, output: run.output };
  }

  // ── AC1 — ancestry sees what no merge subject mentions ───────────────────

  test(
    "AC1 a CR that lands by FAST-FORWARD — leaving no merge commit and no commit subject " +
      "anywhere naming it — is still in the crs of the tag its landing commit is an ancestor of",
    async () => {
      const { repo, mergeShas, releases } = await backfilledAncestry("ancestry-fast-forward");
      const sha = mergeShas.get(FF_CR)!;

      // FIXTURE PRECONDITIONS — the two premises the assertion rests on.
      // (1) No text anywhere can place this CR: zero subjects name it, and the
      //     merge-subject scan in particular has nothing to match.
      expect(subjectsNaming(repo, FF_CR)).toEqual([]);
      expect(git(repo, ["log", "--merges", "--format=%s", "0.1.0"])).not.toContain(FF_CR);
      // (2) Ancestry CAN place it: the recorded sha is an ancestor of 0.1.0.
      expect(isAncestor(repo, sha, "0.1.0")).toBe(true);

      const found = byVersion(releases);
      expect(found.get("0.1.0")!.crs).toContain(FF_CR);
      // BOUND to the earliest containing tag: it is an ancestor of all three
      // tags, so appearing in a later one would be the partition breaking.
      expect(found.get("0.1.1")!.crs).not.toContain(FF_CR);
      expect(found.get("0.1.2")!.crs).not.toContain(FF_CR);
    },
  );

  test(
    "AC1 a CR that lands by SQUASH — one fresh single-parent commit, so its branch commit is " +
      "an ancestor of nothing and no merge subject exists — is in the crs of the tag its " +
      "squash commit precedes",
    async () => {
      const { repo, mergeShas, releases } = await backfilledAncestry("ancestry-squash");
      const sha = mergeShas.get(SQUASH_CR)!;

      expect(subjectsNaming(repo, SQUASH_CR)).toEqual([]);
      expect(git(repo, ["log", "--merges", "--format=%s", "0.1.0"])).not.toContain(SQUASH_CR);
      expect(isAncestor(repo, sha, "0.1.0")).toBe(true);

      const found = byVersion(releases);
      expect(found.get("0.1.0")!.crs).toContain(SQUASH_CR);
      expect(found.get("0.1.1")!.crs).not.toContain(SQUASH_CR);
      expect(found.get("0.1.2")!.crs).not.toContain(SQUASH_CR);
    },
  );

  // ── AC2 — the CR-CRU-021/CR-CRU-023 regression, in fixture form ──────────

  test(
    "AC2 the concrete regression: TWO CRs that shipped in the earliest release with no merge " +
      "subject naming either are BOTH placed in 0.1.0 — the shape CR-CRU-021/CR-CRU-023 have, " +
      "which the subject scan left in NO release's crs",
    async () => {
      const { repo, mergeShas, releases } = await backfilledAncestry("ancestry-regression");

      // The exact shape of the real defect: two COMPLETED CRs, both with a
      // resolvable merge sha that IS an ancestor of the 0.1.0 tag, and neither
      // findable by `git log --merges --grep`.
      for (const cr of [FF_CR, SQUASH_CR]) {
        expect(subjectsNaming(repo, cr)).toEqual([]);
        expect(isAncestor(repo, mergeShas.get(cr)!, "0.1.0")).toBe(true);
      }

      const found = byVersion(releases);
      // POSITIVE and EXACT: 0.1.0's set is precisely what it shipped — not
      // "at least", and not the one CR the subject scan can see.
      expect(sortedCrs(found.get("0.1.0")!.crs)).toEqual([...ANCESTRY_SHIPPED["0.1.0"]!].sort());
      // And neither is missing from provenance ALTOGETHER, which is the bug.
      const everywhere = releases.flatMap((r) => r.crs ?? []);
      expect(everywhere).toContain(FF_CR);
      expect(everywhere).toContain(SQUASH_CR);
    },
  );

  // ── AC3 — attribution stays a PARTITION over the earliest containing tag ─

  test(
    "AC3 attribution is a partition: every placed CR appears in exactly ONE release's crs, each " +
      "release's set is exactly what it shipped, and a CR is attributed to the EARLIEST tag " +
      "containing it even though its sha is an ancestor of every later tag too",
    async () => {
      const { repo, mergeShas, releases } = await backfilledAncestry("ancestry-partition");
      const found = byVersion(releases);

      // Guard: every release must actually carry a set, or disjointness of
      // three empty sets would pass vacuously.
      for (const rel of releases) {
        expect(Array.isArray(rel.crs)).toBe(true);
        expect(rel.crs!.length).toBeGreaterThan(0);
      }

      // EXACT per-release sets.
      for (const [version, crs] of Object.entries(ANCESTRY_SHIPPED)) {
        expect(sortedCrs(found.get(version)!.crs)).toEqual([...crs].sort());
      }

      // DISJOINT: the union's size equals the sum of the parts, and every
      // placed CR is counted exactly once — not "at least once".
      const all = releases.flatMap((r) => r.crs ?? []);
      expect(new Set(all).size).toBe(all.length);
      for (const cr of Object.values(ANCESTRY_SHIPPED).flat()) {
        expect(all.filter((c) => c === cr).length).toBe(1);
      }

      // EARLIEST, explicitly: 0.1.0's CRs are ancestors of 0.1.2 as well, so an
      // "every tag containing it" rule would list them again.
      for (const cr of ANCESTRY_SHIPPED["0.1.0"]!) {
        expect(isAncestor(repo, mergeShas.get(cr)!, "0.1.2")).toBe(true);
        expect(found.get("0.1.2")!.crs).not.toContain(cr);
      }

      // A CR landed after the newest tag is an ancestor of none, so it is in
      // no release — its sha IS recorded, so this is placement, not a gap.
      expect(isAncestor(repo, mergeShas.get(ANCESTRY_UNRELEASED_CR)!, "0.1.2")).toBe(false);
      expect(all).not.toContain(ANCESTRY_UNRELEASED_CR);
    },
  );

  // ── AC4 — a CR with no recorded merge sha is NAMED and COUNTED ───────────

  test(
    "AC4 a CR whose closed plan records NO merge sha is reported as unplaceable — named, and " +
      "counted as exactly one — in the ceremony's own output, and never silently omitted",
    async () => {
      const { output, releases } = await backfilledAncestry("ancestry-unplaceable");

      const reported = output
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /unplaceable/i.test(l));
      // POSITIVE: the ceremony says something about what it could not place.
      expect(reported.length).toBeGreaterThan(0);
      const naming = reported.filter((l) => l.includes(UNPLACEABLE_CR));
      expect(naming.length).toBeGreaterThan(0);
      // COUNTED: §S2 asks for a count alongside the ids, and the fixture has
      // exactly one CR with no recorded sha.
      expect(reported.join("\n")).toMatch(/\b1\b/);

      // NEGATIVE: only the CR that genuinely has no sha is called unplaceable.
      // CR-CRU-199 is placed in no release either, but its sha IS recorded —
      // it simply landed after the newest tag, which is not a gap.
      const line = naming.join("\n");
      for (const cr of [...Object.values(ANCESTRY_SHIPPED).flat(), ANCESTRY_UNRELEASED_CR]) {
        expect(line).not.toContain(cr);
      }

      // And, being unplaceable, it is in no release's crs — the tally is the
      // only reason its absence is visible at all.
      for (const rel of releases) expect(rel.crs).not.toContain(UNPLACEABLE_CR);
    },
  );

  // ── AC6 — provenance is independent of commit-message text ──────────────

  test(
    "AC6 rewriting the merge subjects to REMOVE the CR id changes nothing: the identical " +
      "history with no CR id in any subject computes the identical crs for all three releases",
    async () => {
      const named = await backfilledAncestry("ancestry-subjects-named", true);
      const stripped = await backfilledAncestry("ancestry-subjects-stripped", false);

      // FIXTURE PRECONDITION — the rewrite is real and it is the ONLY change:
      // the named variant's merge subjects carry CR ids, the stripped one's
      // carry none anywhere in the history.
      expect(git(named.repo, ["log", "--merges", "--format=%s"])).toContain("CR-CRU-143");
      expect(git(stripped.repo, ["log", "--all", "--format=%s"])).not.toMatch(/CR-[A-Z]+-[0-9]+/);

      const before = byVersion(named.releases);
      const after = byVersion(stripped.releases);
      for (const [version, crs] of Object.entries(ANCESTRY_SHIPPED)) {
        // Guard: the contract must EXIST, or "identical" is two undefineds.
        expect(Array.isArray(after.get(version)!.crs)).toBe(true);
        expect(sortedCrs(after.get(version)!.crs)).toEqual([...crs].sort());
        expect(sortedCrs(after.get(version)!.crs)).toEqual(sortedCrs(before.get(version)!.crs));
      }
    },
  );
});
