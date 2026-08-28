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

/**
 * CR-CRU-084 §S1 — one delivered artifact's coordinates: the registry it went
 * to, the package NAME on that registry, and its version. Declared by the
 * ceremony at `finish` (never a publish OUTCOME Crucible verified) and carried
 * verbatim, so the wire shape is exactly these three strings.
 */
interface PackageRef {
  registry: string;
  name: string;
  version: string;
}

interface ReleaseBrief {
  version?: string;
  commit?: string;
  timestamp: number;
  releasedAt?: number;
  crs?: string[];
  /** CR-CRU-084 §S2 — the artifacts the release DELIVERED. Absent on a
   *  pre-CR-084 release; EMPTY when the ceremony declared none (§S3). */
  packages?: PackageRef[];
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
 *
 * `flags` are appended verbatim after the subcommand, so the SAME entry point
 * drives both the ordinary re-run and CR-CRU-081 §S3's opt-in repair — the two
 * paths differ by nothing except the flag, which is what makes "opt-in"
 * assertable rather than asserted about two different commands.
 */
async function runBackfill(
  repo: string,
  base: string,
  flags: readonly string[] = [],
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
    cmd: ["bash", RELEASE_SH, "backfill-releases", ...flags],
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

/** §S2 class 2 / AC4b — QUEUED CRs with NO landing record at ANY source: no
 *  plan at all (so the closed-plan map cannot see them, not even with a null
 *  sha) and no `cr-merged` milestone either. This is the real, measured class
 *  — `CR-CRU-001`–`007`, `010`, `016`, nine CRs that demonstrably shipped in
 *  `0.1.0` before plan tracking existed — and the dangerous one, because
 *  ancestry cannot place them AND the narrow §S2 definition never reported
 *  them, so provenance shrank from 58 to 51 CRs in total silence.
 *
 *  TWO of them, deliberately: the class's count is then provably its own (2)
 *  and not the class-1 count (1) reused, which is what AC4c turns on.
 *
 *  They are queued through `extraQueued` rather than added to
 *  `ANCESTRY_QUEUED_CRS`, so the AC1/AC2/AC3/AC4/AC6 fixtures above keep the
 *  exact world they were written against. */
const NO_RECORD_CRS: readonly string[] = ["CR-CRU-101", "CR-CRU-102"];

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

/** The CR ids the project's queue actually holds — the left-hand premise of
 *  AC4b: a CR can only be "queued with no landing record" if it IS queued. */
async function queuedCrs(base: string, key: string): Promise<string[]> {
  const res = await fetch(`${base}/api/v2/projects/${key}/queue`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { entries?: Array<{ cr?: string }> };
  return (body.entries ?? []).map((e) => e.cr ?? "");
}

/** Every plan the project holds for `cr` — zero means there is no plan record
 *  of the CR landing at all (not even a closed one with a null sha), which is
 *  the half of AC4b's premise that `plan_merge_map` is structurally blind to. */
async function plansFor(base: string, key: string, cr: string): Promise<unknown[]> {
  const res = await fetch(`${base}/api/v2/projects/${key}/plans?cr=${cr}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { plans?: unknown[] };
  return body.plans ?? [];
}

/** The project's whole event feed as raw text — used only to PROVE the other
 *  landing source is empty too: no `cr-merged` milestone exists for the CR, so
 *  Crucible genuinely has no record of where it landed. */
async function eventFeedText(base: string, key: string): Promise<string> {
  const res = await fetch(`${base}/api/v2/events?project=${key}&limit=500`);
  expect(res.status).toBe(200);
  return await res.text();
}

/** The ceremony's own unplaceable report, one trimmed line per mention. */
function unplaceableLines(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /unplaceable/i.test(l));
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
   *  closed with NO merge sha at all (§S2/AC4).
   *
   *  `extraQueued` ids are QUEUED AND NOTHING ELSE — no plan is filed for them
   *  and no milestone mentions them — so the queue deliberately holds MORE CRs
   *  than the plan board covers, which is §S2 class 2 / AC4b's whole premise. */
  async function seedAncestryProject(
    base: string,
    repo: string,
    mergeShas: Map<string, string>,
    name: string,
    extraQueued: readonly string[] = [],
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
      entries: [...ANCESTRY_QUEUED_CRS, ...extraQueued].map((cr) => ({
        cr,
        title: `${cr} work`,
        wave: "1",
      })),
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
    extraQueued: readonly string[] = [],
  ): Promise<{
    repo: string;
    mergeShas: Map<string, string>;
    releases: ReleaseBrief[];
    output: string;
    base: string;
    key: string;
  }> {
    const { repo, mergeShas } = buildAncestryRepo(namedSubjects);
    repos.push(repo);
    const base = boot();
    const key = await seedAncestryProject(base, repo, mergeShas, name, extraQueued);
    const run = await runBackfill(repo, base);
    // The failure channel must be clean, or every assertion below is meaningless.
    expect(run.exitCode).toBe(0);
    expect(run.output).not.toMatch(/agent-identity-required/);
    expect(run.output).not.toMatch(/NOT recorded/);
    const releases = await listReleases(base, key);
    expect(releases.length).toBe(3);
    return { repo, mergeShas, releases, output: run.output, base, key };
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

  // ── AC4b / AC4c — the SECOND unplaceable class: no landing record at all ─
  //
  // RED expectation (measured against 9f09563): `report_unplaceable_crs`
  // (scripts/release.sh:493) iterates `plan_merge_map` ALONE, which emits one
  // line per CLOSED PLAN. A queued CR with NO plan produces no line at all, so
  // it is neither placed nor reported — the exact silence that took 0.1.0 from
  // 58 CRs to 51 with no signal. Each test below asserts its preconditions
  // (queued / no plan / no cr-merged milestone) FIRST, so a failure is the
  // missing contract and never a broken fixture.

  test(
    "AC4b a QUEUED CR with NO landing record at any source — no closed plan and no cr-merged " +
      "milestone — is counted and named as unplaceable, and stays absent from every " +
      "release's crs",
    async () => {
      const { output, releases, base, key } = await backfilledAncestry(
        "ancestry-no-landing-record",
        true,
        NO_RECORD_CRS,
      );

      // FIXTURE PRECONDITIONS — the three premises of "queued, and unknown".
      const queue = await queuedCrs(base, key);
      const feed = await eventFeedText(base, key);
      for (const cr of NO_RECORD_CRS) {
        // (1) It IS in the queue — the project filed it.
        expect(queue).toContain(cr);
        // (2) There is NO plan for it — not even a closed one with a null sha,
        //     so the closed-plan map is structurally blind to it.
        expect(await plansFor(base, key, cr)).toEqual([]);
        // (3) And no `cr-merged` milestone covers it either — the second
        //     landing source is empty too, so Crucible truly has no record.
        expect(feed).not.toContain(cr);
      }
      expect(feed).not.toContain("cr-merged");
      // NON-VACUITY: the queue really does hold MORE CRs than the plan board
      // covers, which is the condition the old rule could not see.
      expect(queue.length).toBeGreaterThan(ANCESTRY_QUEUED_CRS.length);

      // POSITIVE — each no-record CR is NAMED in the ceremony's own report.
      const reported = unplaceableLines(output);
      expect(reported.length).toBeGreaterThan(0);
      for (const cr of NO_RECORD_CRS) {
        expect(reported.filter((l) => l.includes(cr)).length).toBeGreaterThan(0);
      }
      // COUNTED — the report carries a count for this class, and the fixture
      // has exactly two such CRs.
      const noRecordLines = reported.filter((l) => NO_RECORD_CRS.some((cr) => l.includes(cr)));
      expect(noRecordLines.join("\n")).toMatch(/\b2\b/);

      // NEGATIVE — reporting must not smuggle them into provenance: they are
      // legitimately absent from every release's crs, and the report is the
      // only reason that absence is visible.
      for (const rel of releases) {
        for (const cr of NO_RECORD_CRS) expect(rel.crs ?? []).not.toContain(cr);
      }
    },
  );

  test(
    "AC4b a CR that simply landed AFTER the last tag — its merge sha recorded, an ancestor of " +
      "no tag — is NOT in the unplaceable tally, while the no-record CRs are: normal " +
      "placement is never reported as a gap",
    async () => {
      const { repo, mergeShas, output } = await backfilledAncestry(
        "ancestry-after-last-tag-not-a-gap",
        true,
        NO_RECORD_CRS,
      );

      // FIXTURE PRECONDITION — CR-CRU-199's sha IS recorded and resolves, yet
      // it precedes no tag, so ancestry legitimately places it nowhere.
      const sha = mergeShas.get(ANCESTRY_UNRELEASED_CR)!;
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      for (const tag of ["0.1.0", "0.1.1", "0.1.2"]) {
        expect(isAncestor(repo, sha, tag)).toBe(false);
      }

      const reported = unplaceableLines(output);
      // NON-VACUITY: the tally EXISTS and does report the genuine gaps, so the
      // negative below is not "nothing was reported at all".
      expect(reported.length).toBeGreaterThan(0);
      for (const cr of [UNPLACEABLE_CR, ...NO_RECORD_CRS]) {
        expect(reported.filter((l) => l.includes(cr)).length).toBeGreaterThan(0);
      }

      // NEGATIVE — and the after-the-last-tag CR is in NO reported line.
      expect(reported.filter((l) => l.includes(ANCESTRY_UNRELEASED_CR))).toEqual([]);
      // Nor is any successfully placed CR reported.
      for (const cr of Object.values(ANCESTRY_SHIPPED).flat()) {
        expect(reported.filter((l) => l.includes(cr))).toEqual([]);
      }
    },
  );

  test(
    "AC4c the tally DISTINGUISHES the two unplaceable classes — 'tracked, but the landing sha " +
      "is missing' and 'no landing record at all' are reported as separately counted, " +
      "disjoint, differently described groups, never one undifferentiated list",
    async () => {
      const { output } = await backfilledAncestry(
        "ancestry-unplaceable-classes",
        true,
        NO_RECORD_CRS,
      );

      const reported = unplaceableLines(output);
      expect(reported.length).toBeGreaterThan(0);

      // Class 1 — a CLOSED plan carrying no merge sha (CR-CRU-170).
      const classOne = reported.filter((l) => l.includes(UNPLACEABLE_CR));
      // Class 2 — queued with no landing record anywhere (CR-CRU-101/102).
      const classTwo = reported.filter((l) => NO_RECORD_CRS.some((cr) => l.includes(cr)));
      expect(classOne.length).toBeGreaterThan(0);
      expect(classTwo.length).toBeGreaterThan(0);

      // DISTINGUISHED — no reported line mixes the two classes' ids, so a
      // reader is never handed one undifferentiated list.
      for (const line of classOne) {
        for (const cr of NO_RECORD_CRS) expect(line).not.toContain(cr);
      }
      for (const line of classTwo) expect(line).not.toContain(UNPLACEABLE_CR);
      expect(classOne.some((l) => classTwo.includes(l))).toBe(false);

      // SEPARATELY COUNTED — one CR in class 1, two in class 2, so a single
      // shared "3 unplaceable" count cannot satisfy both.
      expect(classOne.join("\n")).toMatch(/\b1\b/);
      expect(classOne.join("\n")).not.toMatch(/\b(2|3)\b/);
      expect(classTwo.join("\n")).toMatch(/\b2\b/);
      expect(classTwo.join("\n")).not.toMatch(/\b3\b/);

      // DIFFERENTLY DESCRIBED — with the ids and counts stripped, the two
      // groups' prose still differs: they demand different responses from a
      // reader ("find the sha" vs "Crucible never saw this CR land").
      const prose = (lines: string[]): string =>
        lines
          .join(" ")
          .replace(/CR-[A-Z]+-[0-9]+/g, "")
          .replace(/\d+/g, "")
          .replace(/\s+/g, " ")
          .trim();
      expect(prose(classOne)).not.toBe("");
      expect(prose(classTwo)).not.toBe("");
      expect(prose(classOne)).not.toBe(prose(classTwo));
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

// ---------------------------------------------------------------------------
// D. CR-CRU-081 §S3 — the OPT-IN REPAIR path (RED).
//
// Spec: docs/changes/CR-CRU-081-release-provenance-uses-ancestry.md §S3 + AC5
// (and CR-CRU-084 AC7, which reuses this path and requires it to be
// idempotent). §S1/§S2 shipped already and are covered by section C.
//
//   §S3  the three recorded releases carry provenance produced by the OLD
//        rule. CR-CRU-080 §S3 made release records IMMUTABLE under
//        dedup-replay, so a re-run cannot correct them — this CR adds an
//        explicit, OPT-IN repair path that RE-DERIVES provenance for an
//        already-recorded release.
//   AC5  the repair re-derives provenance for an already-recorded release,
//        AND is opt-in: an ordinary `backfill-releases` re-run remains the
//        idempotent replay CR-CRU-080 §S3 defined.
//
// WHY THIS SECTION EXISTS. `Store.recordMilestoneEvent` (src/store.ts:1701)
// short-circuits a `release` whose (label, commit) it already holds and
// returns the HELD event with `changed:false`; `handleMilestones`
// (src/v2.ts:1164) documents that as "a replay re-computes nothing". That is
// exactly right for idempotency and exactly wrong for correction: provenance
// recorded under the subject-scan rule can never acquire the ancestry-derived
// answer, no matter how many times the ceremony runs. On this repo the only
// way to correct `0.1.0` during CR-CRU-080's dog-food was to hand-delete event
// rows from the live store — the manual workaround §S3 exists to replace.
//
// TECHNIQUE — two ways a release ends up with provenance that is WRONG, both
// built through the REAL paths, never by hand-editing a row:
//
//   * STALE `crs`, ceremony-produced. The project is seeded WITHOUT CR-CRU-141's
//     closed plan, so ancestry has no landing sha for it and the ceremony
//     honestly records `0.1.0` as shipping two CRs. The missing plan is then
//     filed — the landing record arriving late, which is precisely what
//     happened to CR-CRU-021/CR-CRU-023 — so the CURRENT derivation now yields
//     three. Nothing about the world is faked: the stale record was computed,
//     not planted.
//   * MISSING provenance, wire-recorded. `0.1.0` is posted at the server's own
//     `POST /api/v2/milestones` with type/label/commit and NOTHING else — the
//     exact shape the three real releases carried before CR-CRU-080 §S4. The
//     ordinary backfill then records its two SIBLINGS with full provenance in
//     the SAME run while `0.1.0` stays bare, which is an undeniable
//     demonstration that the run computed provenance and the dedup replay
//     refused to write it.
//
// Every test drives `scripts/release.sh` — the same single entry point, the
// same fixture, the same live server — and the ordinary run and the repair
// differ by NOTHING except the flag, so "opt-in" is proven rather than
// asserted about two unrelated commands. Each asserts its preconditions (the
// pre-repair state really is wrong, and the current derivation really would
// say otherwise) BEFORE the outcome, so a broken fixture can never read as a
// RED on the contract.
//
// SAFETY: unchanged from sections A/C — in-process server on `port: 0` over a
// per-test `mktemp` db (never 3849, never data/crucible.db), stopped through
// its own handle; every git fixture under `mktemp`, no remote, no push.
//
// RED expectation (measured against 0f922b6): `scripts/release.sh` has NO
// repair path at all — its argument parser (`:778`) rejects every unrecognised
// flag with `ERROR: unknown flag` and exits `$EXIT_USAGE`, and no code
// anywhere re-derives provenance for a held release (`grep -c repair
// scripts/release.sh src/store.ts src/v2.ts` is 0). So every repair run below
// exits non-zero having recorded nothing, and every post-repair assertion
// fails on provenance that is still the stale/absent value — the missing
// contract, not a broken fixture. The OPT-IN halves (the ordinary re-run
// leaving the record untouched) already PASS today, which is the point: they
// pin the CR-CRU-080 §S3 behaviour that must survive §S3's addition.

/** §S3's opt-in switch on the ceremony's existing entry point. Explicit and
 *  non-default by construction: an ordinary `backfill-releases` never carries
 *  it, so a release record cannot be rewritten by accident (CR-CRU-081 Risk). */
const REPAIR_FLAG = "--repair-provenance";

/** The ancestry fixture's tag dates in epoch SECONDS — the unit `git log -1
 *  --format=%ct <tag>` speaks. `tagRelease` pins each tag's commit to exactly
 *  these instants, so a repaired `releasedAt` has ONE correct value and the
 *  assertion cannot be satisfied by any plausible wrong answer. */
const ANCESTRY_RELEASED_AT: Record<string, number> = {
  "0.1.0": Date.UTC(2026, 6, 10, 12, 0, 0) / 1000,
  "0.1.1": Date.UTC(2026, 6, 15, 9, 30, 0) / 1000,
  "0.1.2": Date.UTC(2026, 6, 20, 16, 45, 0) / 1000,
};

/** The `crs` the ceremony honestly computes for 0.1.0 while CR-CRU-141's
 *  landing record is missing: everything ancestry CAN place, and no more. */
const STALE_010_CRS: readonly string[] = [SQUASH_CR, "CR-CRU-143"];

describe("an already-recorded release can be REPAIRED, and only on purpose (CR-CRU-081 §S3/AC5)", () => {
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
    const dir = mkdtempSync(join(tmpdir(), "release-repair-db-"));
    dbDirs.push(dir);
    handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
    return `http://localhost:${handle.server.port}`;
  }

  /** Section C's world, with one knob: `withoutPlan` CRs get NO closed plan, so
   *  ancestry has no landing sha for them and the ceremony legitimately leaves
   *  them out of `crs`. That is how a STALE record is produced by the real
   *  path instead of planted. */
  async function seedRepairProject(
    base: string,
    repo: string,
    mergeShas: Map<string, string>,
    name: string,
    withoutPlan: readonly string[] = [],
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

    for (const [cr, commit] of mergeShas) {
      if (withoutPlan.includes(cr)) continue;
      await seedClosedPlan(base, key, cr, commit);
    }
    await seedClosedPlan(base, key, UNPLACEABLE_CR, null);

    writeFileSync(join(repo, ".env"), `CRUCIBLE_PROJECT_KEY=${key}\n`);
    return key;
  }

  interface StaleWorld {
    repo: string;
    mergeShas: Map<string, string>;
    base: string;
    key: string;
    /** The three releases exactly as the ceremony first recorded them. */
    stale: Map<string, ReleaseBrief>;
  }

  /**
   * A world whose 0.1.0 provenance is WRONG, and provably so:
   *
   *   1. the project is seeded WITHOUT CR-CRU-141's closed plan;
   *   2. the ceremony runs and honestly records 0.1.0 as shipping two CRs;
   *   3. CR-CRU-141's closed plan — carrying the landing sha that IS an
   *      ancestor of 0.1.0 — is filed afterwards.
   *
   * From step 3 on, the CURRENT derivation says three CRs while the STORED
   * record says two. That gap is the whole subject of §S3, and it is real:
   * step 2's value was computed by the ceremony, not written by the test.
   */
  async function staleCrsWorld(name: string): Promise<StaleWorld> {
    const { repo, mergeShas } = buildAncestryRepo(true);
    repos.push(repo);
    const base = boot();
    const key = await seedRepairProject(base, repo, mergeShas, name, [FF_CR]);

    const first = await runBackfill(repo, base);
    expect(first.exitCode).toBe(0);
    expect(first.output).not.toMatch(/NOT recorded/);
    const stale = byVersion(await listReleases(base, key));
    expect(stale.size).toBe(3);

    // PRECONDITION 1 — the stored provenance really IS wrong, and wrong in the
    // exact way the bug is: a CR that shipped in 0.1.0 is missing from its set.
    expect(Array.isArray(stale.get("0.1.0")!.crs)).toBe(true);
    expect(sortedCrs(stale.get("0.1.0")!.crs)).toEqual([...STALE_010_CRS].sort());
    expect(stale.get("0.1.0")!.crs).not.toContain(FF_CR);

    // The landing record ARRIVES — late, exactly as CR-CRU-021/023's did.
    await seedClosedPlan(base, key, FF_CR, mergeShas.get(FF_CR)!);

    // PRECONDITION 2 — the CURRENT derivation would now place it: the sha is
    // recorded on a closed plan AND is a real ancestor of the 0.1.0 tag. So a
    // stored set that still omits it is stale, not correct.
    expect(await plansFor(base, key, FF_CR)).not.toEqual([]);
    expect(isAncestor(repo, mergeShas.get(FF_CR)!, "0.1.0")).toBe(true);

    return { repo, mergeShas, base, key, stale };
  }

  /**
   * A world whose 0.1.0 record carries NO provenance at all — the CR-CRU-080-era
   * shape, posted at the server's own production entry with type/label/commit
   * and nothing else. Its commit is the tag's real commit, so the ceremony's
   * own emit collapses onto it under the (type, label, commit) dedup.
   */
  async function bareProvenanceWorld(
    name: string,
  ): Promise<{ repo: string; base: string; key: string }> {
    const { repo, mergeShas } = buildAncestryRepo(true);
    repos.push(repo);
    const base = boot();
    const key = await seedRepairProject(base, repo, mergeShas, name);

    const posted = await postJson(base, "/api/v2/milestones", {
      projectKey: key,
      agentId: AGENT_ID,
      type: "release",
      label: "0.1.0",
      commit: git(repo, ["rev-list", "-n", "1", "0.1.0"]),
    });
    expect(posted.status).toBe(201);

    return { repo, base, key };
  }

  // ── AC5 — the repair RE-DERIVES provenance for an already-recorded release ─

  test(
    "AC5 a release whose recorded crs is STALE — computed before the landing record arrived, " +
      "and missing a CR ancestry now places in it — carries the CURRENT ancestry-derived set " +
      "after the opt-in repair",
    async () => {
      const { repo, base, key, stale } = await staleCrsWorld("repair-stale-crs");

      const repaired = await runBackfill(repo, base, [REPAIR_FLAG]);
      // The repair path must EXIST and must run clean, or nothing below means
      // anything.
      expect(repaired.output).not.toMatch(/unknown flag/);
      expect(repaired.exitCode).toBe(0);
      expect(repaired.output).not.toMatch(/NOT recorded/);

      const after = byVersion(await listReleases(base, key));
      // POSITIVE and EXACT: 0.1.0's set is now precisely what it shipped — not
      // "at least", and not the stale two.
      expect(sortedCrs(after.get("0.1.0")!.crs)).toEqual([...ANCESTRY_SHIPPED["0.1.0"]!].sort());
      expect(after.get("0.1.0")!.crs).toContain(FF_CR);
      // CHANGED: the repaired set genuinely differs from the one it replaced.
      expect(sortedCrs(after.get("0.1.0")!.crs)).not.toEqual(sortedCrs(stale.get("0.1.0")!.crs));
      // And `releasedAt` is the CURRENT derivation too — the tag's own commit
      // date, to the second, not the minute the repair ran.
      expect(after.get("0.1.0")!.releasedAt).toBe(ANCESTRY_RELEASED_AT["0.1.0"]);
    },
  );

  test(
    "AC5 a release recorded with NO provenance at all — the pre-CR-CRU-080 shape — gains both " +
      "its real releasedAt and its ancestry-derived crs from the opt-in repair, while an " +
      "ordinary re-run that provably COMPUTES both leaves it bare",
    async () => {
      const { repo, base, key } = await bareProvenanceWorld("repair-missing-provenance");

      // PRECONDITION — the record exists and carries neither field.
      const seeded = byVersion(await listReleases(base, key));
      expect(seeded.size).toBe(1);
      expect(seeded.get("0.1.0")!.releasedAt).toBeUndefined();
      expect(seeded.get("0.1.0")!.crs).toBeUndefined();

      // THE OPT-IN GUARD, in its strongest form: one ordinary run records the
      // two SIBLING tags WITH full provenance — so the run demonstrably
      // computed provenance — and 0.1.0 stays bare, because the dedup replay
      // refuses to write over a held record.
      const ordinary = await runBackfill(repo, base);
      expect(ordinary.exitCode).toBe(0);
      expect(ordinary.output).toContain("3/3 recorded");
      const replayed = byVersion(await listReleases(base, key));
      expect(replayed.size).toBe(3);
      for (const version of ["0.1.1", "0.1.2"]) {
        expect(replayed.get(version)!.releasedAt).toBe(ANCESTRY_RELEASED_AT[version]!);
        expect(sortedCrs(replayed.get(version)!.crs)).toEqual(
          [...ANCESTRY_SHIPPED[version]!].sort(),
        );
      }
      expect(replayed.get("0.1.0")!.releasedAt).toBeUndefined();
      expect(replayed.get("0.1.0")!.crs).toBeUndefined();

      // THE REPAIR — the same command, the same world, one flag.
      const repaired = await runBackfill(repo, base, [REPAIR_FLAG]);
      expect(repaired.output).not.toMatch(/unknown flag/);
      expect(repaired.exitCode).toBe(0);

      const after = byVersion(await listReleases(base, key));
      expect(after.size).toBe(3);
      expect(after.get("0.1.0")!.releasedAt).toBe(ANCESTRY_RELEASED_AT["0.1.0"]);
      expect(sortedCrs(after.get("0.1.0")!.crs)).toEqual([...ANCESTRY_SHIPPED["0.1.0"]!].sort());
    },
  );

  // ── AC5 — and the repair is OPT-IN: an ordinary re-run must NOT do it ─────

  test(
    "AC5 an ordinary backfill-releases re-run does NOT repair: over the SAME stale record it " +
      "reports 3/3 recorded and leaves crs and releasedAt byte-identical, while the same " +
      "command with the repair flag corrects them — so the two paths are provably distinct",
    async () => {
      const { repo, base, key, stale } = await staleCrsWorld("repair-is-opt-in");

      // THE GUARD — an ordinary re-run, with the corrected derivation fully
      // available to it (proven by staleCrsWorld's preconditions).
      const ordinary = await runBackfill(repo, base);
      expect(ordinary.exitCode).toBe(0);
      expect(ordinary.output).toContain("3/3 recorded");
      // NEGATIVE — it must not have taken the repair path implicitly.
      const replayed = byVersion(await listReleases(base, key));
      expect(replayed.size).toBe(3);
      for (const version of Object.keys(ANCESTRY_SHIPPED)) {
        expect(sortedCrs(replayed.get(version)!.crs)).toEqual(sortedCrs(stale.get(version)!.crs));
        expect(replayed.get(version)!.releasedAt).toBe(stale.get(version)!.releasedAt);
      }
      // Said plainly: the stale set survived the re-run untouched.
      expect(replayed.get("0.1.0")!.crs).not.toContain(FF_CR);
      expect(sortedCrs(replayed.get("0.1.0")!.crs)).toEqual([...STALE_010_CRS].sort());

      // THE OTHER PATH — identical command, identical world, plus the flag.
      const repaired = await runBackfill(repo, base, [REPAIR_FLAG]);
      expect(repaired.output).not.toMatch(/unknown flag/);
      expect(repaired.exitCode).toBe(0);

      // DISTINCT: what the ordinary re-run would not change, the repair does.
      const after = byVersion(await listReleases(base, key));
      expect(after.get("0.1.0")!.crs).toContain(FF_CR);
      expect(sortedCrs(after.get("0.1.0")!.crs)).toEqual([...ANCESTRY_SHIPPED["0.1.0"]!].sort());
    },
  );

  // ── AC7 (CR-CRU-084) — the repair is IDEMPOTENT ──────────────────────────

  test(
    "AC7 running the repair TWICE changes nothing the second time: crs and releasedAt are " +
      "identical to the first repair's for every release, and the store still holds exactly " +
      "one row per tag",
    async () => {
      const { repo, base, key } = await staleCrsWorld("repair-is-idempotent");

      const firstRepair = await runBackfill(repo, base, [REPAIR_FLAG]);
      expect(firstRepair.output).not.toMatch(/unknown flag/);
      expect(firstRepair.exitCode).toBe(0);
      const once = byVersion(await listReleases(base, key));
      // NON-VACUITY: the first repair actually did something, so "identical"
      // below is not two copies of the unrepaired state.
      expect(sortedCrs(once.get("0.1.0")!.crs)).toEqual([...ANCESTRY_SHIPPED["0.1.0"]!].sort());

      const secondRepair = await runBackfill(repo, base, [REPAIR_FLAG]);
      expect(secondRepair.output).not.toMatch(/unknown flag/);
      expect(secondRepair.exitCode).toBe(0);

      const twice = await listReleases(base, key);
      // NO DUPLICATION — a repair is a correction, never a second recording.
      expect(twice.length).toBe(3);
      expect(twice.map((r) => r.version).sort()).toEqual(["0.1.0", "0.1.1", "0.1.2"]);

      const settled = byVersion(twice);
      for (const version of Object.keys(ANCESTRY_SHIPPED)) {
        expect(sortedCrs(settled.get(version)!.crs)).toEqual(sortedCrs(once.get(version)!.crs));
        expect(settled.get(version)!.releasedAt).toBe(once.get(version)!.releasedAt);
        expect(settled.get(version)!.commit).toBe(once.get(version)!.commit);
      }
    },
  );

  // ── CR-CRU-084 §S1/§S4/AC7 — the SAME path also carries `packages` ───────
  //
  // Spec: docs/changes/CR-CRU-084-release-records-its-packages.md §S4 — the
  // three shipped releases are corrected "through the CR-081 §S3 repair path
  // (--repair-provenance) rather than a second mechanism" — and AC7, which
  // requires that repair to be idempotent.
  //
  // Placed HERE, inside the §S3 repair section, on purpose: §S4's whole claim
  // is that packages need NO new machinery, so the test that proves it must be
  // the neighbour of the repair tests it reuses — same fixture, same
  // `runBackfill(repo, base, [REPAIR_FLAG])` entry point, one flag apart from
  // the ordinary run.
  //
  // The declared pair is `packagesFor`, the SAME fixture section F pins the
  // wire contract with, so the ceremony's declaration and the server's
  // carriage can never drift into two different answers about what Crucible
  // ships. (A forward reference to a `const` defined lower in the file: legal
  // and evaluated by the time any test body runs.)
  //
  // RED expectation (measured, 2026-08-23): `emit_release_milestone`
  // (scripts/release.sh:620-644) appends only `--released-at`, `--crs` and
  // `--repair-provenance` — `grep -c packages scripts/release.sh` is 0 — and
  // no client's `milestone` subparser declares `--packages`. So both the
  // first recording and the repair post nothing about packages, and every
  // assertion below fails on `undefined`. The crs/releasedAt halves already
  // pass today, which is the point: they are the non-regression this addition
  // must not cost.

  test(
    "AC7/§S4 the repair carries PACKAGES through the SAME path: the ordinary backfill already " +
      "records each release's declared pair at its OWN tag's version, the opt-in repair leaves " +
      "them intact while it corrects crs, and a second repair changes neither — identical " +
      "packages, identical provenance, still exactly one row per tag",
    async () => {
      const { repo, base, key, stale } = await staleCrsWorld("repair-carries-packages");

      // FIRST RECORDING (§S1, through the ordinary ceremony run staleCrsWorld
      // already performed): every release declares its two artifacts, each
      // stamped with that release's OWN tag — three different versions, so a
      // single hard-coded pair could not satisfy all three.
      for (const version of Object.keys(ANCESTRY_SHIPPED)) {
        expect(stale.get(version)!.packages).toEqual(packagesFor(version));
      }

      const firstRepair = await runBackfill(repo, base, [REPAIR_FLAG]);
      expect(firstRepair.output).not.toMatch(/unknown flag/);
      expect(firstRepair.output).not.toMatch(/unrecognized arguments/);
      expect(firstRepair.exitCode).toBe(0);

      const once = byVersion(await listReleases(base, key));
      // NON-VACUITY — the repair really did correct something, so "unchanged"
      // below is not two copies of an untouched world.
      expect(sortedCrs(once.get("0.1.0")!.crs)).toEqual([...ANCESTRY_SHIPPED["0.1.0"]!].sort());
      expect(sortedCrs(once.get("0.1.0")!.crs)).not.toEqual([...STALE_010_CRS].sort());

      // …and it carried the packages with it, per release, still at its tag.
      for (const version of Object.keys(ANCESTRY_SHIPPED)) {
        expect(once.get(version)!.packages).toEqual(packagesFor(version));
        expect(once.get(version)!.packages!.map((p) => p.version)).toEqual([version, version]);
      }

      const secondRepair = await runBackfill(repo, base, [REPAIR_FLAG]);
      expect(secondRepair.output).not.toMatch(/unknown flag/);
      expect(secondRepair.exitCode).toBe(0);

      const twice = await listReleases(base, key);
      // IDEMPOTENT — a repair is a correction, never a second recording.
      expect(twice.length).toBe(3);
      for (const version of Object.keys(ANCESTRY_SHIPPED)) {
        expect(twice.filter((r) => r.version === version).length).toBe(1);
      }

      const settled = byVersion(twice);
      for (const version of Object.keys(ANCESTRY_SHIPPED)) {
        expect(settled.get(version)!.packages).toEqual(once.get(version)!.packages);
        // NO PROVENANCE REGRESSION — CR-CRU-080's two fields ride through
        // untouched, so `packages` was added ALONGSIDE them, not over them.
        expect(sortedCrs(settled.get(version)!.crs)).toEqual(sortedCrs(once.get(version)!.crs));
        expect(settled.get(version)!.releasedAt).toBe(ANCESTRY_RELEASED_AT[version]!);
        expect(settled.get(version)!.commit).toBe(once.get(version)!.commit);
      }
    },
  );

  // ── the partition CR-CRU-080 AC10 guarantees survives a repair ────────────

  test(
    "a repair keeps attribution a PARTITION: every placed CR is still in exactly ONE release's " +
      "crs, each release's set is exactly what it shipped, and the newly repaired CR is " +
      "attributed to the EARLIEST tag containing it rather than smeared across all three",
    async () => {
      const { repo, mergeShas, base, key } = await staleCrsWorld("repair-keeps-partition");

      const repaired = await runBackfill(repo, base, [REPAIR_FLAG]);
      expect(repaired.output).not.toMatch(/unknown flag/);
      expect(repaired.exitCode).toBe(0);

      const releases = await listReleases(base, key);
      const found = byVersion(releases);

      // Guard: three non-empty sets, or disjointness would pass vacuously.
      expect(releases.length).toBe(3);
      for (const rel of releases) {
        expect(Array.isArray(rel.crs)).toBe(true);
        expect(rel.crs!.length).toBeGreaterThan(0);
      }

      // EXACT per-release sets — the repair corrected 0.1.0 without disturbing
      // what its siblings shipped.
      for (const [version, crs] of Object.entries(ANCESTRY_SHIPPED)) {
        expect(sortedCrs(found.get(version)!.crs)).toEqual([...crs].sort());
      }

      // DISJOINT: every placed CR is counted exactly once across the union.
      const all = releases.flatMap((r) => r.crs ?? []);
      expect(new Set(all).size).toBe(all.length);
      for (const cr of Object.values(ANCESTRY_SHIPPED).flat()) {
        expect(all.filter((c) => c === cr).length).toBe(1);
      }

      // EARLIEST, for the repaired CR specifically: its sha is an ancestor of
      // all three tags, so a repair that re-derived without the partition rule
      // would list it in every one of them.
      const sha = mergeShas.get(FF_CR)!;
      for (const tag of ["0.1.0", "0.1.1", "0.1.2"]) {
        expect(isAncestor(repo, sha, tag)).toBe(true);
      }
      expect(found.get("0.1.0")!.crs).toContain(FF_CR);
      expect(found.get("0.1.1")!.crs).not.toContain(FF_CR);
      expect(found.get("0.1.2")!.crs).not.toContain(FF_CR);
    },
  );

  // ── a repair corrects provenance and NOTHING else ────────────────────────

  test(
    "a repair changes provenance ONLY: every release keeps the identical version and commit, " +
      "no tag gains a second release row, and the two releases whose provenance was already " +
      "correct come back unchanged",
    async () => {
      const { repo, base, key, stale } = await staleCrsWorld("repair-no-collateral-change");

      const repaired = await runBackfill(repo, base, [REPAIR_FLAG]);
      expect(repaired.output).not.toMatch(/unknown flag/);
      expect(repaired.exitCode).toBe(0);

      const releases = await listReleases(base, key);
      // NO SECOND ROW — for any tag, not just in aggregate.
      expect(releases.length).toBe(3);
      for (const version of Object.keys(ANCESTRY_SHIPPED)) {
        expect(releases.filter((r) => r.version === version).length).toBe(1);
      }

      const after = byVersion(releases);
      // IDENTITY UNTOUCHED — a repair re-derives provenance, never the release
      // it belongs to. The commits are real 40-hex tag commits, so this is a
      // comparison of values, not of two undefineds.
      for (const version of Object.keys(ANCESTRY_SHIPPED)) {
        expect(stale.get(version)!.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(after.get(version)!.commit).toBe(stale.get(version)!.commit);
        expect(after.get(version)!.version).toBe(stale.get(version)!.version);
      }

      // NEIGHBOURS UNTOUCHED — only the stale release moved.
      for (const version of ["0.1.1", "0.1.2"]) {
        expect(sortedCrs(after.get(version)!.crs)).toEqual(sortedCrs(stale.get(version)!.crs));
        expect(after.get(version)!.releasedAt).toBe(stale.get(version)!.releasedAt);
        expect(after.get(version)!.releasedAt).toBe(ANCESTRY_RELEASED_AT[version]!);
      }
      // …and it moved in exactly one respect.
      expect(sortedCrs(after.get("0.1.0")!.crs)).not.toEqual(sortedCrs(stale.get("0.1.0")!.crs));
      expect(after.get("0.1.0")!.releasedAt).toBe(stale.get("0.1.0")!.releasedAt);
    },
  );
});

// ---------------------------------------------------------------------------
// E. CR-CRU-086 — the provenance REPAIR must never ERASE provenance (RED).
//
// Spec: docs/changes/CR-CRU-086-repair-must-not-erase-provenance.md
// §S1 + §S2 + §S3 + AC1-AC7.
//
//   §S1  on the repair path an EMPTY `crs` is *no answer*, not *the answer*:
//        only a NON-EMPTY derivation may replace a stored set, and a missing
//        or unresolvable date never blanks a stored `releasedAt`.
//   §S2  a repair that cannot compute REFUSES that release and says why —
//        per-release and non-fatal, having written nothing.
//   §S3  a repair that would SHRINK a stored set reports the count before,
//        the count after and the CR ids being removed. A legitimate shrink
//        stays possible; a SILENT one does not.
//
// WHY THIS SECTION EXISTS — measured, not hypothetical. Dog-fooding
// `backfill-releases --repair-provenance` on this project ERASED the
// provenance it was built to correct: `0.1.0` went from 58 CRs to 0, and the
// wiped store is kept as data/crucible.db.wiped-by-081-repair for forensics.
// The mechanism is one operator: `Store.repairReleaseProvenance`
// (src/store.ts:1777) spreads `...(crs !== undefined ? { crs } : {})`, so
// `undefined` is guarded and `[]` — a PRESENT, well-formed "nothing" — is
// persisted over the stored set. The ceremony even said so out loud:
// `crs=(none registered)`, and then wrote anyway.
//
// The empty set's ORIGIN is correct and is deliberately untouched here: the
// client's `release_crs` (clients/_crucible_axi.py:1638) truthfully returns
// the empty intersection when the registered queue knows none of the scanned
// ids (CR-CRU-080 §S4 — never fall back to the raw scan). That is right at
// RECORD time and destructive only when persisted over an existing set at
// REPAIR time, so every test below aims at the WRITE decision.
//
// WHY THE EXISTING §S3 FIXTURES MISSED IT — the crux of this section. Every
// CR-CRU-081 §S3 fixture above (`seedRepairProject`) REGISTERS a queue before
// repairing, so the intersection is never empty in test. The destructive path
// needs a queue that is unregistered or empty — precisely a project that just
// cleared its roadmap, or one before its first `queue-file`. Both are built
// here, through the real paths:
//
//   * `clearedQueueWorld` — REGISTERED-BUT-EMPTY. The queue is registered, the
//     ceremony records all three releases with full provenance, and only THEN
//     is the queue cleared through `POST …/queue {entries: []}` — the
//     full-replace CR-CRU-014 §S1 defines, not a hand-edited row. The stored
//     sets under test were therefore computed by the ceremony itself.
//   * `unregisteredQueueWorld` — NO QUEUE AT ALL. The queue endpoint is never
//     posted, so the project has none, and `0.1.0` is planted at the server's
//     own `POST /api/v2/milestones` carrying the LIVE shape: 58 CRs.
//
// Each ceremony test proves its PRE-state before asserting any outcome, and
// proves it through the real paths rather than by assumption
// (`provenanceIsUnderivable`): an ORDINARY, non-repair backfill runs first —
// CR-CRU-080 §S3's dedup replay, which writes nothing — and the REAL client's
// own line for that release reads `crs=(none registered)`, so the derivation
// is shown to be empty by the code that computes it, while the stored set is
// re-read and is still the full one. Only then does the repair run.
//
// SAFETY: unchanged from sections A/C/D — in-process server on `port: 0` over
// a per-test `mktemp` db (never 3849, never data/crucible.db), stopped through
// its own handle; every git fixture under `mktemp`, no remote, no push.
//
// RED expectation (measured against 7fa6a8e):
//   * `repairReleaseProvenance` persists `[]`, so AC1 / AC2b / AC7 fail with
//     the stored set replaced by an empty one, and the route answering
//     `201 changed:true` where the contract requires `200 changed:false`.
//   * nothing anywhere refuses a degraded repair or reports a shrink — no
//     RUNTIME output line of the backfill matches /refus/i or /shrink|remov/i
//     — so AC3's refusal lines and AC5's shrink report are absent entirely and
//     those tests fail on an empty report before they reach the store.
//   * AC2a and AC4 pin behaviour that must SURVIVE the guard (an absent date
//     still preserves; a NON-EMPTY derivation still replaces), so the fix can
//     never be implemented as "never write". They pass today by design, in the
//     same spirit as section D's opt-in halves.
// ---------------------------------------------------------------------------

/** The live shape that was wiped: `0.1.0`'s 58 CRs as data/crucible.db held
 *  them before `--repair-provenance` ran. Fifty-eight ids exactly, because AC1
 *  names the count — a stored set this large cannot be mistaken for a fixture
 *  artefact, and "58 after" is a claim only a real guard can satisfy. */
const LIVE_010_CRS: readonly string[] = Array.from(
  { length: 58 },
  (_, i) => `CR-CRU-${String(i + 1).padStart(3, "0")}`,
);

/** The CR-CRU-080-era `releasedAt` the three real releases carried: the
 *  BACKFILL's own ingest minute, a month after the tags it described. Stored
 *  deliberately WRONG so "unchanged" is a specific wrong value the current
 *  code demonstrably overwrites — never two copies of the right answer. */
const INGEST_MINUTE_RELEASED_AT = Date.UTC(2026, 7, 21, 13, 45, 0) / 1000;

/** The ceremony's own per-release provenance line, printed by the REAL client
 *  (`milestone: ok=… label=<v> … crs=…`). It is the derivation as the code that
 *  computed it reports it, which is what makes "the derivation was empty" an
 *  observation rather than an assumption. */
function milestoneLinesFor(output: string, version: string): string[] {
  const label = new RegExp(`\\blabel=${version.replace(/\./g, "\\.")}(\\s|$)`);
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("milestone:") && label.test(l));
}

/** §S2's refusal, as the ceremony prints it: the lines that say a release was
 *  REFUSED. Silence here is the whole defect — the run that wiped 0.1.0 said
 *  `crs=(none registered)` and nothing else. */
function refusalLines(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /refus/i.test(l));
}

/** §S3's shrink report: the lines that surface a stored set being REDUCED. */
function shrinkLines(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /shrink|shrank|shrunk|remov/i.test(l));
}

describe("an EMPTY derivation never overwrites a stored provenance set (CR-CRU-086 §S1/AC1/AC2/AC4)", () => {
  let handle: ServerHandle | undefined;
  const dbDirs: string[] = [];
  let base = "";

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    for (const d of dbDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** In-process server on an OS-assigned port over a throwaway on-disk db —
   *  never 3849, never data/crucible.db. Stopped by handle in afterEach. */
  function boot(): void {
    const dir = mkdtempSync(join(tmpdir(), "release-guard-db-"));
    dbDirs.push(dir);
    handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
    base = `http://localhost:${handle.server.port}`;
  }

  async function createProject(name: string): Promise<string> {
    const res = await postJson(base, "/api/v2/projects", { name });
    const body = (await res.json()) as { project: { key: string } };
    const key = body.project.key;
    const reg = await postJson(base, "/api/v2/agents/register", {
      projectKey: key,
      agentId: AGENT_ID,
      role: "ORCHESTRATOR",
    });
    expect(reg.status).toBe(200);
    return key;
  }

  /**
   * A release post at the server's OWN production entry — the path the client
   * posts to, so the guard is exercised where it has to live rather than
   * around it. Every field is forwarded exactly as given, so a deliberately
   * EMPTY `crs` stays a PRESENT field on the wire (which is the whole defect),
   * and `repair` carries CR-CRU-081 §S3's opt-in.
   *
   * Returns the route's own answer — status plus `changed` — because "wrote
   * nothing" is a contract the caller must be able to SEE, not merely infer
   * from a later read.
   */
  async function postRelease(
    key: string,
    fields: {
      label: string;
      commit: string;
      releasedAt?: number;
      crs?: readonly string[];
      repair?: boolean;
    },
  ): Promise<{ status: number; changed: boolean }> {
    const res = await postJson(base, "/api/v2/milestones", {
      projectKey: key,
      agentId: AGENT_ID,
      type: "release",
      label: fields.label,
      commit: fields.commit,
      ...(fields.releasedAt !== undefined ? { releasedAt: fields.releasedAt } : {}),
      ...(fields.crs !== undefined ? { crs: fields.crs } : {}),
      ...(fields.repair === true ? { repairProvenance: true } : {}),
    });
    const body = (await res.json()) as { changed?: boolean };
    return { status: res.status, changed: body.changed === true };
  }

  test(
    "AC1 the live shape that was wiped: a release holding 58 CRs, repaired with an EMPTY " +
      "derivation, still holds the SAME 58 afterwards — the repair reports nothing changed " +
      "and writes nothing",
    async () => {
      boot();
      const key = await createProject("guard-empty-crs-keeps-58");
      const commit = "a".repeat(40);

      const planted = await postRelease(key, {
        label: "0.1.0",
        commit,
        releasedAt: ANCESTRY_RELEASED_AT["0.1.0"]!,
        crs: LIVE_010_CRS,
      });
      expect(planted.status).toBe(201);

      // PRE-STATE 1 — the stored set really is non-empty, and it is the live
      // shape: 58 ids, exactly those. Without this the "58 after" below could
      // be satisfied by a fixture that never stored anything.
      const before = byVersion(await listReleases(base, key));
      expect(before.get("0.1.0")!.crs!.length).toBe(58);
      expect(sortedCrs(before.get("0.1.0")!.crs)).toEqual([...LIVE_010_CRS].sort());

      // PRE-STATE 2 — an EMPTY `crs` is a PRESENT, well-formed field on this
      // wire and not an omitted one: recorded fresh on a sibling label it
      // lands as `[]`, an array. That is precisely why the repair persisted it
      // over 58 good CRs, and it proves the derivation this test hands the
      // repair below is an ANSWER OF NOTHING rather than a missing field.
      const control = await postRelease(key, { label: "0.0.9", commit: "b".repeat(40), crs: [] });
      expect(control.status).toBe(201);
      expect(byVersion(await listReleases(base, key)).get("0.0.9")!.crs).toEqual([]);

      // THE DESTRUCTIVE CALL, verbatim: the same (label, commit), the opt-in
      // repair, and the empty intersection the client computes when the queue
      // knows none of the scanned ids.
      const repaired = await postRelease(key, {
        label: "0.1.0",
        commit,
        releasedAt: ANCESTRY_RELEASED_AT["0.1.0"]!,
        crs: [],
        repair: true,
      });

      const releases = await listReleases(base, key);
      const after = byVersion(releases);
      // POSITIVE and EXACT — the same 58, not "at least" and not a subset.
      // Asserted FIRST, so a failure names the data loss itself.
      expect(after.get("0.1.0")!.crs!.length).toBe(58);
      expect(sortedCrs(after.get("0.1.0")!.crs)).toEqual([...LIVE_010_CRS].sort());
      // NEGATIVE — the erasure specifically did not happen.
      expect(after.get("0.1.0")!.crs).not.toEqual([]);
      // A refusal is not a second recording either.
      expect(releases.filter((r) => r.version === "0.1.0").length).toBe(1);
      // WROTE NOTHING, and SAID so: the codebase's uniform "nothing changed"
      // answer, not a 201 announcing a write.
      expect(repaired.changed).toBe(false);
      expect(repaired.status).toBe(200);
    },
  );

  test(
    "AC2a a repair that carries NO releasedAt — the shape emit_release_milestone posts when " +
      "git could not answer the tag's date — leaves the stored releasedAt untouched while it " +
      "still corrects crs, so a missing date never blanks a stored one",
    async () => {
      boot();
      const key = await createProject("guard-missing-date-preserves");
      const commit = "c".repeat(40);
      const stale = ["CR-CRU-041"];

      expect(
        (
          await postRelease(key, {
            label: "0.1.0",
            commit,
            releasedAt: INGEST_MINUTE_RELEASED_AT,
            crs: stale,
          })
        ).status,
      ).toBe(201);

      // PRE-STATE — both fields are stored, and the date is a specific value.
      const before = byVersion(await listReleases(base, key));
      expect(before.get("0.1.0")!.releasedAt).toBe(INGEST_MINUTE_RELEASED_AT);
      expect(sortedCrs(before.get("0.1.0")!.crs)).toEqual(stale);

      // The repair answers the CR set and NOT the date — `releasedAt` is
      // omitted entirely, exactly as the ceremony omits `--released-at` when
      // `release_ship_date` comes back empty.
      const corrected = ["CR-CRU-041", "CR-CRU-042"];
      const repaired = await postRelease(key, { label: "0.1.0", commit, crs: corrected, repair: true });
      expect(repaired.status).toBe(201);
      expect(repaired.changed).toBe(true);

      const after = byVersion(await listReleases(base, key));
      // The date SURVIVED, at its exact stored value.
      expect(after.get("0.1.0")!.releasedAt).toBe(INGEST_MINUTE_RELEASED_AT);
      // NON-VACUITY — the repair genuinely ran and wrote the half it answered.
      expect(sortedCrs(after.get("0.1.0")!.crs)).toEqual(corrected);
    },
  );

  test(
    "AC2b a repair whose CR derivation is EMPTY writes NEITHER field: the stored releasedAt " +
      "keeps its own value even though the post carries a different, derivable date, because " +
      "a release the repair cannot compute is left alone rather than half-rewritten",
    async () => {
      boot();
      const key = await createProject("guard-empty-crs-preserves-date");
      const commit = "d".repeat(40);

      expect(
        (
          await postRelease(key, {
            label: "0.1.0",
            commit,
            releasedAt: INGEST_MINUTE_RELEASED_AT,
            crs: LIVE_010_CRS,
          })
        ).status,
      ).toBe(201);

      // PRE-STATE — a stored, non-empty set AND a stored date that DIFFERS
      // from the one the repair will carry, so "unchanged" below is a claim
      // about a specific value the current code overwrites.
      const before = byVersion(await listReleases(base, key));
      expect(before.get("0.1.0")!.crs!.length).toBe(58);
      expect(before.get("0.1.0")!.releasedAt).toBe(INGEST_MINUTE_RELEASED_AT);
      expect(ANCESTRY_RELEASED_AT["0.1.0"]).not.toBe(INGEST_MINUTE_RELEASED_AT);

      const repaired = await postRelease(key, {
        label: "0.1.0",
        commit,
        releasedAt: ANCESTRY_RELEASED_AT["0.1.0"]!,
        crs: [],
        repair: true,
      });

      const after = byVersion(await listReleases(base, key));
      // The stored date SURVIVED — asserted before the route's own answer, so
      // a failure names the value that was overwritten.
      expect(after.get("0.1.0")!.releasedAt).toBe(INGEST_MINUTE_RELEASED_AT);
      expect(after.get("0.1.0")!.releasedAt).not.toBe(ANCESTRY_RELEASED_AT["0.1.0"]);
      expect(sortedCrs(after.get("0.1.0")!.crs)).toEqual([...LIVE_010_CRS].sort());
      expect(repaired.changed).toBe(false);
      expect(repaired.status).toBe(200);
    },
  );

  test(
    "AC4 the guard is not 'never write': a NON-EMPTY derivation still replaces a stale stored " +
      "set and a stale stored date in the same repair, and the route answers 201 changed:true",
    async () => {
      boot();
      const key = await createProject("guard-non-empty-still-replaces");
      const commit = "e".repeat(40);
      const stale = ["CR-CRU-041", "CR-CRU-999"];
      const corrected = ["CR-CRU-041", "CR-CRU-042", "CR-CRU-043"];

      expect(
        (
          await postRelease(key, {
            label: "0.1.0",
            commit,
            releasedAt: INGEST_MINUTE_RELEASED_AT,
            crs: stale,
          })
        ).status,
      ).toBe(201);

      const before = byVersion(await listReleases(base, key));
      expect(sortedCrs(before.get("0.1.0")!.crs)).toEqual([...stale].sort());
      expect(before.get("0.1.0")!.releasedAt).toBe(INGEST_MINUTE_RELEASED_AT);

      const repaired = await postRelease(key, {
        label: "0.1.0",
        commit,
        releasedAt: ANCESTRY_RELEASED_AT["0.1.0"]!,
        crs: corrected,
        repair: true,
      });
      expect(repaired.status).toBe(201);
      expect(repaired.changed).toBe(true);

      const releases = await listReleases(base, key);
      const after = byVersion(releases);
      // The stale set was genuinely REPLACED — exactly, and by the new answer.
      expect(sortedCrs(after.get("0.1.0")!.crs)).toEqual([...corrected].sort());
      expect(after.get("0.1.0")!.crs).not.toContain("CR-CRU-999");
      expect(after.get("0.1.0")!.releasedAt).toBe(ANCESTRY_RELEASED_AT["0.1.0"]);
      // Still a correction, never a second recording.
      expect(releases.length).toBe(1);
    },
  );
});

describe("a repair that cannot compute REFUSES loudly and never shrinks in silence (CR-CRU-086 §S2/§S3/AC3/AC5/AC6/AC7)", () => {
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
    const dir = mkdtempSync(join(tmpdir(), "release-refusal-db-"));
    dbDirs.push(dir);
    handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
    return `http://localhost:${handle.server.port}`;
  }

  /**
   * The ancestry world with the QUEUE as an explicit knob — the one thing
   * every existing §S3 fixture holds fixed, and therefore the one thing that
   * has to move for this CR:
   *
   *   "registered"   — the queue holds `queued`, as `seedRepairProject` does.
   *   "empty"        — the queue is REGISTERED and holds nothing (`entries:
   *                    []`, CR-CRU-014 §S1's full replace): a project that
   *                    cleared its roadmap.
   *   "unregistered" — the queue endpoint is NEVER posted: a project before
   *                    its first `queue-file`.
   *
   * The CLOSED PLANS are seeded in every variant, so the ceremony's ancestry
   * derivation is always NON-empty and the empty answer provably comes from
   * the queue intersection — the CR-CRU-080 §S4 path this CR must not change.
   */
  async function seedWorld(
    base: string,
    repo: string,
    mergeShas: Map<string, string>,
    name: string,
    queue: "registered" | "empty" | "unregistered",
    queued: readonly string[] = ANCESTRY_QUEUED_CRS,
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

    if (queue !== "unregistered") {
      const posted = await postJson(base, `/api/v2/projects/${key}/queue`, {
        entries: queue === "empty" ? [] : queued.map((cr) => ({ cr, title: `${cr} work`, wave: "1" })),
      });
      expect(posted.status).toBe(200);
    }

    for (const [cr, commit] of mergeShas) await seedClosedPlan(base, key, cr, commit);
    await seedClosedPlan(base, key, UNPLACEABLE_CR, null);

    writeFileSync(join(repo, ".env"), `CRUCIBLE_PROJECT_KEY=${key}\n`);
    return key;
  }

  /** The queue is EMPTY as the server reports it — the premise every test in
   *  this block rests on, read back through the same GET the client's
   *  `release_crs` intersects against. */
  async function expectQueueEmpty(base: string, key: string): Promise<void> {
    expect(await queuedCrs(base, key)).toEqual([]);
  }

  /**
   * REGISTERED-BUT-EMPTY. The queue is registered, the ceremony records all
   * three releases with genuine ancestry-derived provenance, and only THEN is
   * the queue cleared. Nothing is planted: the stored sets under test are the
   * ceremony's own output, so "the repair erased what the ceremony computed"
   * is the literal claim.
   */
  async function clearedQueueWorld(
    name: string,
  ): Promise<{ repo: string; base: string; key: string; recorded: Map<string, ReleaseBrief> }> {
    const { repo, mergeShas } = buildAncestryRepo(true);
    repos.push(repo);
    const base = boot();
    const key = await seedWorld(base, repo, mergeShas, name, "registered");

    const first = await runBackfill(repo, base);
    expect(first.exitCode).toBe(0);
    expect(first.output).toContain("3/3 recorded");
    const recorded = byVersion(await listReleases(base, key));
    // The pre-state is REAL provenance, not an artefact: each release holds
    // exactly what its tag range shipped.
    expect(recorded.size).toBe(3);
    for (const [version, crs] of Object.entries(ANCESTRY_SHIPPED)) {
      expect(sortedCrs(recorded.get(version)!.crs)).toEqual([...crs].sort());
      expect(recorded.get(version)!.crs!.length).toBeGreaterThan(0);
    }

    // THE ROADMAP IS CLEARED — the full-replace verb, with nothing in it.
    const cleared = await postJson(base, `/api/v2/projects/${key}/queue`, { entries: [] });
    expect(cleared.status).toBe(200);
    await expectQueueEmpty(base, key);

    return { repo, base, key, recorded };
  }

  /**
   * NO QUEUE AT ALL — AC7's world. The queue endpoint is never posted, and
   * `0.1.0` is planted at the server's own production entry carrying the LIVE
   * shape (58 CRs and the backfill-era ingest-minute date), so the run under
   * test is the one that actually happened on this repo.
   */
  async function unregisteredQueueWorld(
    name: string,
  ): Promise<{ repo: string; base: string; key: string }> {
    const { repo, mergeShas } = buildAncestryRepo(true);
    repos.push(repo);
    const base = boot();
    const key = await seedWorld(base, repo, mergeShas, name, "unregistered");
    await expectQueueEmpty(base, key);

    const planted = await postJson(base, "/api/v2/milestones", {
      projectKey: key,
      agentId: AGENT_ID,
      type: "release",
      label: "0.1.0",
      commit: git(repo, ["rev-list", "-n", "1", "0.1.0"]),
      releasedAt: INGEST_MINUTE_RELEASED_AT,
      crs: LIVE_010_CRS,
    });
    expect(planted.status).toBe(201);

    return { repo, base, key };
  }

  /**
   * The PRE-STATE proof, through the real paths and BEFORE any repair runs:
   * an ORDINARY backfill (CR-CRU-080 §S3's dedup replay, so it writes nothing)
   * whose own client line for each named release reads `crs=(none registered)`
   * — the derivation is empty as reported by the code that computes it — while
   * the stored sets are re-read and are still exactly `stored`.
   *
   * This is what makes the outcome assertions non-vacuous: without it, "the
   * set survived" could mean the repair had nothing to erase.
   */
  async function provenanceIsUnderivable(
    repo: string,
    base: string,
    key: string,
    stored: Map<string, ReleaseBrief>,
  ): Promise<void> {
    const probe = await runBackfill(repo, base);
    expect(probe.exitCode).toBe(0);
    expect(probe.output).not.toMatch(/NOT recorded/);

    for (const version of stored.keys()) {
      const lines = milestoneLinesFor(probe.output, version);
      // The ceremony DID compute and post provenance for this release...
      expect(lines.length).toBeGreaterThan(0);
      // ...and the CR half of that answer came back EMPTY, in the client's own
      // words. This is the exact line the run that wiped 0.1.0 printed.
      expect(lines.some((l) => l.includes("crs=(none registered)"))).toBe(true);
    }

    const still = byVersion(await listReleases(base, key));
    for (const [version, brief] of stored) {
      expect(sortedCrs(still.get(version)!.crs)).toEqual(sortedCrs(brief.crs));
      expect(still.get(version)!.crs!.length).toBeGreaterThan(0);
      expect(still.get(version)!.releasedAt).toBe(brief.releasedAt);
    }
  }

  test(
    "AC3 with the roadmap CLEARED the repair REFUSES every affected release, names each one " +
      "and the queue as the reason, exits non-fatally, and leaves all three stored crs sets " +
      "byte-identical to what the ceremony had computed",
    async () => {
      const { repo, base, key, recorded } = await clearedQueueWorld("refuse-cleared-queue");
      await provenanceIsUnderivable(repo, base, key, recorded);

      const repaired = await runBackfill(repo, base, [REPAIR_FLAG]);
      // NON-FATAL: a refusal is per-release, so the ceremony finishes.
      expect(repaired.output).not.toMatch(/unknown flag/);
      expect(repaired.exitCode).toBe(0);

      // LOUD — silence is what made this destructive.
      const refused = refusalLines(repaired.output);
      expect(refused.length).toBeGreaterThan(0);
      const said = refused.join("\n");
      // NAMES THEM — every release it declined to repair.
      for (const version of Object.keys(ANCESTRY_SHIPPED)) expect(said).toContain(version);
      // AND THE REASON — the registered queue, not a bare "skipped".
      expect(said).toMatch(/queue/i);

      // WROTE NOTHING — every set is exactly what it was, and nothing is empty.
      const after = byVersion(await listReleases(base, key));
      expect(after.size).toBe(3);
      for (const [version, crs] of Object.entries(ANCESTRY_SHIPPED)) {
        expect(sortedCrs(after.get(version)!.crs)).toEqual([...crs].sort());
        expect(sortedCrs(after.get(version)!.crs)).toEqual(sortedCrs(recorded.get(version)!.crs));
        expect(after.get(version)!.crs).not.toEqual([]);
        expect(after.get(version)!.releasedAt).toBe(ANCESTRY_RELEASED_AT[version]!);
      }
    },
  );

  test(
    "AC5 a repair that legitimately SHRINKS a stored set reports the count before, the count " +
      "after and the removed CR ids — the 58-to-51 case, where CRs in the stored set have no " +
      "landing record — and still applies the shrink",
    async () => {
      const { repo, mergeShas } = buildAncestryRepo(true);
      repos.push(repo);
      const base = boot();
      const key = await seedWorld(base, repo, mergeShas, "report-legitimate-shrink", "registered", [
        ...ANCESTRY_QUEUED_CRS,
        ...NO_RECORD_CRS,
      ]);

      // The stored set is the CURRENT set plus two CRs that are QUEUED yet
      // have no landing record at any source — the real 58-to-51 shape, where
      // nine such CRs made 0.1.0's stored set larger than ancestry can place.
      const overstated = [...ANCESTRY_SHIPPED["0.1.0"]!, ...NO_RECORD_CRS];
      const planted = await postJson(base, "/api/v2/milestones", {
        projectKey: key,
        agentId: AGENT_ID,
        type: "release",
        label: "0.1.0",
        commit: git(repo, ["rev-list", "-n", "1", "0.1.0"]),
        releasedAt: ANCESTRY_RELEASED_AT["0.1.0"]!,
        crs: overstated,
      });
      expect(planted.status).toBe(201);

      // PRE-STATE — five stored, and the two extras genuinely have no landing
      // record, so the shrink about to happen is a CORRECTION and not a loss.
      const before = byVersion(await listReleases(base, key));
      expect(before.get("0.1.0")!.crs!.length).toBe(5);
      expect(sortedCrs(before.get("0.1.0")!.crs)).toEqual([...overstated].sort());
      for (const cr of NO_RECORD_CRS) {
        expect(await plansFor(base, key, cr)).toEqual([]);
        expect(await queuedCrs(base, key)).toContain(cr);
      }

      const repaired = await runBackfill(repo, base, [REPAIR_FLAG]);
      expect(repaired.output).not.toMatch(/unknown flag/);
      expect(repaired.exitCode).toBe(0);

      // REPORTED — never silent.
      const reported = shrinkLines(repaired.output);
      expect(reported.length).toBeGreaterThan(0);
      const said = reported.join("\n");
      expect(said).toContain("0.1.0");
      // The COUNT BEFORE and the COUNT AFTER, both, on the shrink report only
      // — so the ceremony's other tallies cannot satisfy this.
      expect(said).toMatch(/\b5\b/);
      expect(said).toMatch(/\b3\b/);
      // The IDS BEING REMOVED, named.
      for (const cr of NO_RECORD_CRS) expect(said).toContain(cr);

      // AND APPLIED — a legitimate shrink must remain possible.
      const after = byVersion(await listReleases(base, key));
      expect(sortedCrs(after.get("0.1.0")!.crs)).toEqual([...ANCESTRY_SHIPPED["0.1.0"]!].sort());
      expect(after.get("0.1.0")!.crs!.length).toBe(3);
      for (const cr of NO_RECORD_CRS) expect(after.get("0.1.0")!.crs).not.toContain(cr);
    },
  );

  test(
    "AC6 the guard keeps the repair IDEMPOTENT and the attribution a PARTITION: over a cleared " +
      "queue two consecutive repairs leave identical sets, one row per tag, and every placed CR " +
      "still in exactly one release",
    async () => {
      const { repo, base, key, recorded } = await clearedQueueWorld("guard-keeps-idempotent");
      await provenanceIsUnderivable(repo, base, key, recorded);

      const first = await runBackfill(repo, base, [REPAIR_FLAG]);
      expect(first.output).not.toMatch(/unknown flag/);
      expect(first.exitCode).toBe(0);
      const once = byVersion(await listReleases(base, key));

      const second = await runBackfill(repo, base, [REPAIR_FLAG]);
      expect(second.output).not.toMatch(/unknown flag/);
      expect(second.exitCode).toBe(0);

      const releases = await listReleases(base, key);
      // NO DUPLICATION — a refused repair is not a recording either.
      expect(releases.length).toBe(3);
      for (const version of Object.keys(ANCESTRY_SHIPPED)) {
        expect(releases.filter((r) => r.version === version).length).toBe(1);
      }

      const twice = byVersion(releases);
      for (const version of Object.keys(ANCESTRY_SHIPPED)) {
        // IDEMPOTENT — and non-vacuously so: the sets are the real, non-empty
        // provenance the ceremony computed, not two copies of nothing.
        expect(sortedCrs(twice.get(version)!.crs)).toEqual(sortedCrs(once.get(version)!.crs));
        expect(sortedCrs(twice.get(version)!.crs)).toEqual(
          [...ANCESTRY_SHIPPED[version]!].sort(),
        );
        expect(twice.get(version)!.releasedAt).toBe(ANCESTRY_RELEASED_AT[version]!);
        expect(twice.get(version)!.commit).toBe(recorded.get(version)!.commit);
      }

      // PARTITION — pairwise disjoint, every placed CR counted exactly once.
      const all = releases.flatMap((r) => r.crs ?? []);
      expect(all.length).toBeGreaterThan(0);
      expect(new Set(all).size).toBe(all.length);
      for (const cr of Object.values(ANCESTRY_SHIPPED).flat()) {
        expect(all.filter((c) => c === cr).length).toBe(1);
      }
    },
  );

  test(
    "AC7 regression: with NO queue registered at all the repair leaves a release holding 58 " +
      "CRs holding the same 58, and says so — the exact path that shipped broken and wiped " +
      "0.1.0 on this project",
    async () => {
      const { repo, base, key } = await unregisteredQueueWorld("regression-no-queue-registered");

      const planted = byVersion(await listReleases(base, key));
      expect(planted.size).toBe(1);
      await provenanceIsUnderivable(repo, base, key, planted);

      // THE RUN THAT WIPED IT — same command, same world, one flag.
      const repaired = await runBackfill(repo, base, [REPAIR_FLAG]);
      expect(repaired.output).not.toMatch(/unknown flag/);
      expect(repaired.exitCode).toBe(0);

      const releases = await listReleases(base, key);
      const after = byVersion(releases);
      // THE ERASURE DID NOT HAPPEN: 58 before, 58 after, the same ids.
      expect(after.get("0.1.0")!.crs!.length).toBe(58);
      expect(sortedCrs(after.get("0.1.0")!.crs)).toEqual([...LIVE_010_CRS].sort());
      expect(after.get("0.1.0")!.crs).not.toEqual([]);
      // The stored date survives with it — nothing about the release was
      // half-rewritten.
      expect(after.get("0.1.0")!.releasedAt).toBe(INGEST_MINUTE_RELEASED_AT);
      // One row, still.
      expect(releases.filter((r) => r.version === "0.1.0").length).toBe(1);
      // AND IT WAS SAID: the release is named as refused, with the queue as
      // the reason. `crs=(none registered)` followed by silence is the defect.
      const said = refusalLines(repaired.output).join("\n");
      expect(said).toContain("0.1.0");
      expect(said).toMatch(/queue/i);
    },
  );
});

// ---------------------------------------------------------------------------
// F. CR-CRU-084 — a release records the PACKAGES it delivered (C1 RED).
//
// Spec: docs/changes/CR-CRU-084-release-records-its-packages.md
// §S1 + §S2 + §S3 + §S4 + AC1/AC2/AC3/AC4/AC5/AC6/AC7.
//
//   §S1  the release milestone gains `packages`: per delivered artifact, its
//        registry, its package NAME and its version. Recorded at `finish`,
//        payload-carried, so NO column and NO migration (AC6).
//   §S2  `releaseBrief` exposes it on GET …/releases, alongside `version`,
//        `commit`, `releasedAt` and `crs`.
//   §S3  an EMPTY `packages` on a FIRST recording is a MEANINGFUL fact and is
//        kept; a release recorded BEFORE this CR carries no `packages` key at
//        all, and the two are distinguishable on the wire (AC4).
//   §S4  the CR-CRU-081 §S3 repair path carries `packages` too, inheriting
//        CR-CRU-086's write rule extended to the field (AC7).
//
// SERVER-SIDE ONLY, deliberately: this cycle pins the WIRE. The ceremony's
// capture (`--packages`, `emit_release_milestone`, the §S4 backfill run) is a
// LATER cycle and is not tested here — which is why every test below drives
// the server's own production entry (`POST /api/v2/milestones`) over real
// HTTP, the way sections B and E do, and never `Store` directly. Rendering
// the empty state is CR-CRU-078's and is not tested here either (§S3).
//
// Crucible does NOT verify that a publish succeeded or that a package is
// reachable (user ruling 2026-08-23, spec Non-goals): `packages` is what the
// ceremony DECLARED. So no test below consults CI, a registry or a network.
//
// RED expectation (measured against the current tree) — `packages` has no
// notion anywhere on the server side, at FIVE seams, so every assertion about
// it fails and the field never reaches the wire:
//   * `src/v2.ts:1160-1186` whitelists `releasedAt`/`crs`/`repairProvenance`
//     and nothing else, so the field is dropped at the route.
//   * `Store.recordMilestoneEvent`'s `meta` (src/store.ts:1712-1719) has no
//     `packages` member.
//   * `Store.payloadColumn` (src/store.ts:2187-2207) is a WHITELIST, so even a
//     carried field would not be persisted…
//   * …nor read back: `toEvent` (src/store.ts:2286-2287) projects exactly
//     `releasedAt` and `crs` out of the payload blob.
//   * `releaseBrief` (src/v2.ts:1664-1672) spreads neither.
// And AC7 arm (b) fails for a SIXTH, sharper reason that survives all of the
// above: `repairReleaseProvenance` (src/store.ts:1800-1805) takes
// `(held, releasedAt, crs)` and opens with a WHOLE-REPAIR, `crs`-KEYED early
// return — `if (crs !== undefined && crs.length === 0) return {held, false}` —
// so a packages-only correction is silently dropped by a guard about a
// different field. That guard must become PER-FIELD.
//
// SAFETY: unchanged from sections A-E — in-process server on `port: 0` over a
// per-test `mktemp` db (never 3849, never data/crucible.db), stopped through
// its own handle. No git fixture is needed at all here: the ceremony is not
// under test in this cycle.
// ---------------------------------------------------------------------------

/** The release these tests record. A version distinct from every fixture tag
 *  above, so no assertion can be satisfied by another section's data. */
const PKG_VERSION = "0.9.9";

/**
 * AC1/AC2 — the two artifacts every Crucible release delivers, version-locked
 * to the release tag. Built FROM the version rather than beside it, because
 * AC2 is structural: the entries' version IS the release version, so a test
 * that spelled it twice could not tell a locked pair from a coincidence.
 */
const packagesFor = (version: string): PackageRef[] => [
  { registry: "pypi", name: "crucible-axi", version },
  { registry: "npm", name: "@anthill-tec/crucible-server", version },
];

describe("a release records the PACKAGES it delivered, on the wire (CR-CRU-084 §S1/§S2/§S3/AC1-AC7)", () => {
  let handle: ServerHandle | undefined;
  const dbDirs: string[] = [];
  let base = "";

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    for (const d of dbDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** In-process server on an OS-assigned port over a throwaway on-disk db —
   *  never 3849, never data/crucible.db. Stopped by handle in afterEach. */
  function boot(): void {
    const dir = mkdtempSync(join(tmpdir(), "release-packages-db-"));
    dbDirs.push(dir);
    handle = startServer({ port: 0, dbPath: join(dir, "crucible.db") });
    base = `http://localhost:${handle.server.port}`;
  }

  async function createProject(name: string): Promise<string> {
    const res = await postJson(base, "/api/v2/projects", { name });
    const body = (await res.json()) as { project: { key: string } };
    const key = body.project.key;
    const reg = await postJson(base, "/api/v2/agents/register", {
      projectKey: key,
      agentId: AGENT_ID,
      role: "ORCHESTRATOR",
    });
    expect(reg.status).toBe(200);
    return key;
  }

  /**
   * A release post at the server's OWN production entry — the same helper
   * shape section E uses, plus `packages`.
   *
   * `packages` is keyed on PRESENCE (`"packages" in fields`), never on
   * `undefined`, because AC4's whole point is that an omitted field and an
   * empty array are DIFFERENT facts; and it is typed `unknown` so a malformed
   * value (a non-array, an entry missing a field) reaches the route exactly as
   * a careless caller would send it, which is what the never-coerce tests
   * need.
   *
   * Returns the route's own answer — status, `changed` and the event id —
   * because "wrote nothing" and "the SAME row" are contracts the caller must
   * be able to SEE rather than infer from a later read.
   */
  async function postRelease(
    key: string,
    fields: {
      label: string;
      commit: string;
      releasedAt?: number;
      crs?: readonly unknown[];
      packages?: unknown;
      repair?: boolean;
    },
  ): Promise<{ status: number; changed: boolean; event: string | undefined }> {
    const res = await postJson(base, "/api/v2/milestones", {
      projectKey: key,
      agentId: AGENT_ID,
      type: "release",
      label: fields.label,
      commit: fields.commit,
      ...(fields.releasedAt !== undefined ? { releasedAt: fields.releasedAt } : {}),
      ...(fields.crs !== undefined ? { crs: fields.crs } : {}),
      ...("packages" in fields ? { packages: fields.packages } : {}),
      ...(fields.repair === true ? { repairProvenance: true } : {}),
    });
    const body = (await res.json()) as { changed?: boolean; event?: string };
    return { status: res.status, changed: body.changed === true, event: body.event };
  }

  /** The single release of a project, read back OFF THE WIRE. */
  async function onlyRelease(key: string): Promise<ReleaseBrief> {
    const releases = await listReleases(base, key);
    expect(releases.length).toBe(1);
    return releases[0]!;
  }

  // ── AC1/AC2/AC3 — the round trip ────────────────────────────────────────

  test(
    "AC1/AC3 a release recorded with its two declared packages reads back off GET …/releases " +
      "carrying BOTH, in the order they were declared, alongside version/commit/releasedAt/crs",
    async () => {
      boot();
      const key = await createProject("packages-wire-round-trip");
      const commit = "f".repeat(40);
      const shipped = ["CR-CRU-084", "CR-CRU-086"];
      const declared = packagesFor(PKG_VERSION);

      const posted = await postRelease(key, {
        label: PKG_VERSION,
        commit,
        releasedAt: ANCESTRY_RELEASED_AT["0.1.2"]!,
        crs: shipped,
        packages: declared,
      });
      expect(posted.status).toBe(201);
      expect(posted.changed).toBe(true);

      const rel = await onlyRelease(key);
      // AC1/AC3 — both delivered artifacts, verbatim, ORDER PRESERVED.
      // Asserted first, so a failure names the missing fact itself.
      expect(rel.packages).toEqual(declared);
      expect(rel.packages!.map((p) => p.registry)).toEqual(["pypi", "npm"]);
      expect(rel.packages!.map((p) => p.name)).toEqual([
        "crucible-axi",
        "@anthill-tec/crucible-server",
      ]);
      // AC2, structurally: every entry's version IS the release version, read
      // from the SAME record — never a second copy of a literal.
      const recordedVersion = rel.version!;
      for (const pkg of rel.packages!) expect(pkg.version).toBe(recordedVersion);
      // AC3 — "alongside": the CR-CRU-074/080 fields come from the same brief
      // and are unchanged neighbours, not casualties of the new one.
      expect(rel.version).toBe(PKG_VERSION);
      expect(rel.commit).toBe(commit);
      expect(rel.releasedAt).toBe(ANCESTRY_RELEASED_AT["0.1.2"]);
      expect(sortedCrs(rel.crs)).toEqual([...shipped].sort());
      expect(typeof rel.timestamp).toBe("number");
    },
  );

  // ── AC4 — an empty declaration and no declaration are DIFFERENT facts ────

  test(
    "AC4 empty vs absent, in ONE test so neither half can pass vacuously: a release recorded " +
      "with packages:[] reads back with an EXPLICIT empty array, while a pre-CR-084-shaped " +
      "release recorded without the key omits `packages` entirely",
    async () => {
      boot();
      const key = await createProject("packages-empty-vs-absent");

      // Recorded WITH the field, declaring nothing — §S3's meaningful fact.
      expect(
        (await postRelease(key, { label: "0.9.8", commit: "a".repeat(40), packages: [] })).status,
      ).toBe(201);
      // Recorded WITHOUT the field at all — the shape every release predating
      // this CR carries.
      expect((await postRelease(key, { label: "0.9.7", commit: "b".repeat(40) })).status).toBe(201);

      const releases = byVersion(await listReleases(base, key));
      const declaredNone = releases.get("0.9.8")!;
      const preCr084 = releases.get("0.9.7")!;

      // HALF 1 — PRESENT and empty: the ceremony looked and delivered none.
      expect("packages" in declaredNone).toBe(true);
      expect(declaredNone.packages).toEqual([]);
      expect(Array.isArray(declaredNone.packages)).toBe(true);
      expect(declaredNone.packages!.length).toBe(0);

      // HALF 2 — ABSENT: a pre-CR-084 release makes no claim at all, and is
      // NOT reported as an empty delivery (which would say it shipped nothing).
      expect("packages" in preCr084).toBe(false);
      expect(preCr084.packages).toBeUndefined();

      // THE DISTINCTION ITSELF — stated once, on the two records together, so
      // no implementation can satisfy both halves by collapsing them.
      expect("packages" in declaredNone).not.toBe("packages" in preCr084);
    },
  );

  // ── never-coerce validation (CR-CRU-073 §S1, as `crs` does it) ───────────
  //
  // DROP GRANULARITY, read off `src/v2.ts:1164-1166` — `crs` is
  // `Array.isArray(body.crs) ? body.crs.filter(wellFormed) : undefined`, which
  // is TWO rules at TWO granularities:
  //   * a value that is NOT AN ARRAY drops the whole FIELD (→ `undefined`, so
  //     the record carries no key), and
  //   * an array drops ill-formed MEMBERS, keeping the well-formed ones.
  // `packages` inherits both, with a well-formed entry being one whose
  // `registry`, `name` and `version` are all NON-EMPTY strings (the same bar
  // `crs` sets for a member: `typeof === "string" && length > 0`).
  // Malformed input is never fatal — a published release must not be blocked
  // by a reporting gap (§S3) — so each case asserts what the route STORED,
  // read back off the wire, not merely its HTTP status.

  test(
    "never-coerce (member granularity, missing fields): entries lacking registry, name or " +
      "version are DROPPED individually while the well-formed sibling is kept, and the post is " +
      "not fatal",
    async () => {
      boot();
      const key = await createProject("packages-drop-incomplete-entries");
      const wellFormed = packagesFor(PKG_VERSION)[0]!;

      const posted = await postRelease(key, {
        label: PKG_VERSION,
        commit: "c".repeat(40),
        packages: [
          { name: "crucible-axi", version: PKG_VERSION }, // no registry
          { registry: "pypi", version: PKG_VERSION }, // no name
          { registry: "npm", name: "@anthill-tec/crucible-server" }, // no version
          wellFormed,
        ],
      });
      // Carried, never refused.
      expect(posted.status).toBe(201);

      const rel = await onlyRelease(key);
      expect(rel.packages).toEqual([wellFormed]);
      // NEGATIVE — no half-entry was stored, and nothing was invented to fill
      // a missing field.
      for (const pkg of rel.packages!) {
        expect(typeof pkg.registry).toBe("string");
        expect(typeof pkg.name).toBe("string");
        expect(typeof pkg.version).toBe("string");
      }
    },
  );

  test(
    "never-coerce (member granularity, wrong types): entries whose registry/name/version are " +
      "not non-empty STRINGS are DROPPED individually — never stringified — while the " +
      "well-formed sibling is kept",
    async () => {
      boot();
      const key = await createProject("packages-drop-mistyped-entries");
      const wellFormed = packagesFor(PKG_VERSION)[1]!;

      const posted = await postRelease(key, {
        label: PKG_VERSION,
        commit: "d".repeat(40),
        packages: [
          { registry: 42, name: "crucible-axi", version: PKG_VERSION },
          { registry: "npm", name: null, version: PKG_VERSION },
          { registry: "pypi", name: "crucible-axi", version: 0.99 },
          { registry: "", name: "crucible-axi", version: PKG_VERSION },
          { registry: "pypi", name: "crucible-axi", version: "" },
          "crucible-axi@0.9.9",
          null,
          wellFormed,
        ],
      });
      expect(posted.status).toBe(201);

      const rel = await onlyRelease(key);
      expect(rel.packages).toEqual([wellFormed]);
      // NEGATIVE — the numbers were dropped, not coerced to "42"/"0.99", and
      // the empty strings did not survive as blank coordinates.
      const flat = JSON.stringify(rel.packages);
      expect(flat).not.toContain("42");
      expect(flat).not.toContain("0.99");
      expect(rel.packages!.every((p) => p.registry.length > 0 && p.name.length > 0)).toBe(true);
      expect(rel.packages!.every((p) => p.version.length > 0)).toBe(true);
    },
  );

  test(
    "never-coerce (FIELD granularity): a `packages` that is not an array drops the whole FIELD " +
      "— the record carries NO packages key, and specifically NOT the empty array AC4 makes " +
      "mean 'delivered nothing'; anchored in the same test by a WELL-FORMED array that IS " +
      "carried, so 'absent' can never be satisfied by a server with no notion of the field",
    async () => {
      boot();
      const key = await createProject("packages-drop-non-array");

      const cases: Array<{ label: string; commit: string; packages: unknown }> = [
        { label: "0.9.1", commit: "1".repeat(40), packages: "crucible-axi@0.9.9" },
        {
          label: "0.9.2",
          commit: "2".repeat(40),
          packages: { registry: "pypi", name: "crucible-axi", version: PKG_VERSION },
        },
        { label: "0.9.3", commit: "3".repeat(40), packages: null },
        { label: "0.9.4", commit: "4".repeat(40), packages: 2 },
      ];
      for (const c of cases) {
        expect((await postRelease(key, c)).status).toBe(201);
      }

      const releases = byVersion(await listReleases(base, key));
      expect(releases.size).toBe(cases.length);
      for (const c of cases) {
        const rel = releases.get(c.label)!;
        // The FIELD is gone — a malformed value must not fabricate the §S3
        // fact that the ceremony declared no packages.
        expect("packages" in rel).toBe(false);
        expect(rel.packages).toBeUndefined();
        expect(rel.packages).not.toEqual([]);
        // …and the release itself was still recorded.
        expect(rel.commit).toBe(c.commit);
      }

      // NON-VACUITY ANCHOR — without this the whole test is satisfied by a
      // server that simply has no `packages` at all (which is exactly the tree
      // this RED runs against). A WELL-FORMED array, in the SAME project and
      // through the SAME route, must come back PRESENT: only then is "absent"
      // above a statement about the malformed VALUE rather than about the
      // field's very existence.
      const declared = packagesFor(PKG_VERSION);
      expect(
        (await postRelease(key, { label: "0.9.5", commit: "5".repeat(40), packages: declared }))
          .status,
      ).toBe(201);
      const carried = byVersion(await listReleases(base, key)).get("0.9.5")!;
      expect("packages" in carried).toBe(true);
      expect(carried.packages).toEqual(declared);
    },
  );

  test(
    "never-coerce, the granularity CONSEQUENCE stated on purpose: an ARRAY whose every entry " +
      "is ill-formed filters down to a PRESENT empty array (not an absent field), exactly as " +
      "today's `crs: [42]` does — asserted side by side so the two fields cannot drift",
    async () => {
      boot();
      const key = await createProject("packages-all-entries-dropped");

      const posted = await postRelease(key, {
        label: PKG_VERSION,
        commit: "5".repeat(40),
        // The SIBLING PRECEDENT, in the same request: `crs` filters its
        // members, so an all-bad array becomes `[]` — a PRESENT field. This
        // half passes against the current tree and is what fixes the reading.
        crs: [42, null, ""],
        packages: [{ registry: 42 }, null, "pypi/crucible-axi"],
      });
      expect(posted.status).toBe(201);

      const rel = await onlyRelease(key);
      // The precedent, observed rather than assumed.
      expect("crs" in rel).toBe(true);
      expect(rel.crs).toEqual([]);
      // `packages` follows it, member-filter for member-filter.
      expect("packages" in rel).toBe(true);
      expect(rel.packages).toEqual([]);
    },
  );

  // ── AC5 — provenance intact, and the dedup replay unchanged ─────────────

  test(
    "AC5 adding packages changes neither `crs` nor `releasedAt`, and a REPLAY (identical " +
      "type/label/commit) returns the HELD event with its packages unchanged — changed:false, " +
      "the same event id, no second release row",
    async () => {
      boot();
      const key = await createProject("packages-provenance-intact-and-replay");
      const commit = "6".repeat(40);
      const shipped = ["CR-CRU-080", "CR-CRU-084"];
      const declared = packagesFor(PKG_VERSION);

      const first = await postRelease(key, {
        label: PKG_VERSION,
        commit,
        releasedAt: ANCESTRY_RELEASED_AT["0.1.2"]!,
        crs: shipped,
        packages: declared,
      });
      expect(first.status).toBe(201);
      expect(first.changed).toBe(true);

      // PRE-STATE — all three facts stored, so "unchanged" below is a claim
      // about specific values a re-recording would have replaced.
      const before = await onlyRelease(key);
      expect(before.releasedAt).toBe(ANCESTRY_RELEASED_AT["0.1.2"]);
      expect(sortedCrs(before.crs)).toEqual([...shipped].sort());
      expect(before.packages).toEqual(declared);

      // THE REPLAY — same type/label/commit, NO repair opt-in, deliberately
      // carrying a DIFFERENT date, an EMPTY crs and DIFFERENT packages. CR-080
      // §S3: a replay re-computes nothing and writes nothing.
      const replay = await postRelease(key, {
        label: PKG_VERSION,
        commit,
        releasedAt: INGEST_MINUTE_RELEASED_AT,
        crs: [],
        packages: [{ registry: "npm", name: "not-what-shipped", version: "9.9.9" }],
      });
      expect(replay.status).toBe(200);
      expect(replay.changed).toBe(false);
      // The HELD event, by identity — not a look-alike second row.
      expect(replay.event).toBe(first.event);

      const after = await onlyRelease(key);
      expect(after.packages).toEqual(declared);
      expect(after.packages).not.toContainEqual({
        registry: "npm",
        name: "not-what-shipped",
        version: "9.9.9",
      });
      expect(after.releasedAt).toBe(ANCESTRY_RELEASED_AT["0.1.2"]);
      expect(sortedCrs(after.crs)).toEqual([...shipped].sort());
      expect(after.timestamp).toBe(before.timestamp);
    },
  );

  // ── AC7 — the repair path carries packages, and is idempotent ───────────

  test(
    "AC7 a --repair-provenance post carrying a NON-EMPTY packages UPDATES the held release IN " +
      "PLACE — same event id, `label`, `commit` and ingest timestamp — and running it twice is " +
      "idempotent: the second run writes nothing and the record is byte-identical",
    async () => {
      boot();
      const key = await createProject("packages-repair-in-place");
      const commit = "7".repeat(40);
      const shipped = ["CR-CRU-060", "CR-CRU-061"];
      const declared = packagesFor("0.1.2");

      // The pre-CR-084 shape §S4 exists to correct: provenance recorded by the
      // CR-080 ceremony, NO packages — so there is nothing to inherit and the
      // repair below is the only possible source of the field.
      const planted = await postRelease(key, {
        label: "0.1.2",
        commit,
        releasedAt: ANCESTRY_RELEASED_AT["0.1.2"]!,
        crs: shipped,
      });
      expect(planted.status).toBe(201);
      const before = await onlyRelease(key);
      expect("packages" in before).toBe(false);

      const repaired = await postRelease(key, {
        label: "0.1.2",
        commit,
        releasedAt: ANCESTRY_RELEASED_AT["0.1.2"]!,
        crs: shipped,
        packages: declared,
        repair: true,
      });
      expect(repaired.status).toBe(201);
      expect(repaired.changed).toBe(true);

      const after = await onlyRelease(key);
      expect(after.packages).toEqual(declared);
      // A CORRECTION, never a second recording: the SAME row throughout.
      expect(repaired.event).toBe(planted.event);
      expect(after.version).toBe("0.1.2");
      expect(after.commit).toBe(commit);
      expect(after.timestamp).toBe(before.timestamp);
      expect(after.releasedAt).toBe(ANCESTRY_RELEASED_AT["0.1.2"]);
      expect(sortedCrs(after.crs)).toEqual([...shipped].sort());

      // IDEMPOTENT — the identical repair again writes nothing, says so, and
      // leaves a byte-identical record.
      const twice = await postRelease(key, {
        label: "0.1.2",
        commit,
        releasedAt: ANCESTRY_RELEASED_AT["0.1.2"]!,
        crs: shipped,
        packages: declared,
        repair: true,
      });
      expect(twice.status).toBe(200);
      expect(twice.changed).toBe(false);
      expect(twice.event).toBe(planted.event);
      expect(await onlyRelease(key)).toEqual(after);
    },
  );

  test(
    "AC7 + CR-CRU-086, arm (a): a repair whose derived packages is EMPTY leaves a stored " +
      "NON-EMPTY packages untouched — on the repair path an empty derivation is *no answer*, " +
      "not *the answer*, exactly as CR-CRU-086 §S1 drew the line for `crs`",
    async () => {
      boot();
      const key = await createProject("packages-guard-empty-never-overwrites");
      const commit = "8".repeat(40);
      const shipped = ["CR-CRU-060", "CR-CRU-061"];
      const stored = packagesFor("0.1.2");

      expect(
        (
          await postRelease(key, {
            label: "0.1.2",
            commit,
            releasedAt: ANCESTRY_RELEASED_AT["0.1.2"]!,
            crs: shipped,
            packages: stored,
          })
        ).status,
      ).toBe(201);

      // PRE-STATE 1 — the stored set really is non-empty.
      const before = byVersion(await listReleases(base, key)).get("0.1.2")!;
      expect(before.packages).toEqual(stored);

      // PRE-STATE 2 — an EMPTY `packages` is a PRESENT, well-formed field on
      // this wire and not an omitted one (AC4 above): recorded fresh on a
      // sibling label it lands as `[]`. That is what makes the derivation
      // handed to the repair below an ANSWER OF NOTHING rather than a missing
      // field — and therefore what makes it destructive if persisted.
      expect(
        (await postRelease(key, { label: "0.0.9", commit: "9".repeat(40), packages: [] })).status,
      ).toBe(201);
      expect(byVersion(await listReleases(base, key)).get("0.0.9")!.packages).toEqual([]);

      const repaired = await postRelease(key, {
        label: "0.1.2",
        commit,
        releasedAt: ANCESTRY_RELEASED_AT["0.1.2"]!,
        crs: shipped,
        packages: [],
        repair: true,
      });

      const releases = await listReleases(base, key);
      const after = byVersion(releases).get("0.1.2")!;
      // POSITIVE and EXACT — asserted first, so a failure names the data loss.
      expect(after.packages).toEqual(stored);
      // NEGATIVE — the erasure specifically did not happen.
      expect(after.packages).not.toEqual([]);
      // WROTE NOTHING, and SAID so.
      expect(repaired.changed).toBe(false);
      expect(repaired.status).toBe(200);
      // A refusal is not a second recording either.
      expect(releases.filter((r) => r.version === "0.1.2").length).toBe(1);
    },
  );

  test(
    "AC7 + CR-CRU-086, arm (b) — THE PER-FIELD CLAIM: a repair carrying a NON-EMPTY packages " +
      "and an EMPTY crs still APPLIES the packages — and the corrected releasedAt that arrived " +
      "with them — while leaving the stored crs alone, so a packages-only correction is never " +
      "dropped by a guard about `crs`",
    async () => {
      boot();
      const key = await createProject("packages-guard-is-per-field");
      const commit = "b".repeat(40);

      // The measured live shape of `0.1.0`: 58 CRs, no packages at all (as
      // every release recorded before this CR), and — CR-CRU-081 §S3's own
      // motivating defect — a `releasedAt` stamped at the INGEST minute
      // rather than at the tag's own commit date.
      //
      // That stored date is deliberately WRONG, and deliberately different
      // from the one the repair posts below: cell 6b of the write rule (a
      // `releasedAt` DOES land when `crs` derived empty but `packages` did
      // not — the narrowing of CR-CRU-086's "releasedAt included" clause to
      // "only when EVERY offered set was empty") is unobservable if the
      // repair re-posts the value already stored. Then "the date moved" and
      // "the whole record was left alone" read identically.
      expect(
        (
          await postRelease(key, {
            label: "0.1.0",
            commit,
            releasedAt: INGEST_MINUTE_RELEASED_AT,
            crs: LIVE_010_CRS,
          })
        ).status,
      ).toBe(201);

      const before = byVersion(await listReleases(base, key)).get("0.1.0")!;
      expect(before.crs!.length).toBe(58);
      expect("packages" in before).toBe(false);
      // …and the stored date really is the wrong one, so the assertion below
      // discriminates a WRITE from a no-op instead of restating the fixture.
      expect(before.releasedAt).toBe(INGEST_MINUTE_RELEASED_AT);

      // THE PACKAGES-ONLY REPAIR, in the §S4 backfill's real shape for 0.1.0:
      // the ONE package that release actually put on a registry (PyPI; its npm
      // publish job failed, gap analysis "measured history"), supplied by hand
      // as a historical fact — while the queue intersection comes back EMPTY,
      // which is precisely the input today's whole-repair, `crs`-keyed early
      // return (src/store.ts:1805) turns into a silent no-op.
      const only: PackageRef[] = [{ registry: "pypi", name: "crucible-axi", version: "0.1.0" }];
      const repaired = await postRelease(key, {
        label: "0.1.0",
        commit,
        releasedAt: ANCESTRY_RELEASED_AT["0.1.0"]!,
        crs: [],
        packages: only,
        repair: true,
      });

      const after = await onlyRelease(key);
      // (b1) the packages half APPLIED — asserted first, so a failure names
      // the dropped correction itself.
      expect(after.packages).toEqual(only);
      // (b2) the crs half PRESERVED — the empty derivation still wrote nothing
      // THERE. Both halves in one record: that is what "per field" means.
      expect(after.crs!.length).toBe(58);
      expect(sortedCrs(after.crs)).toEqual([...LIVE_010_CRS].sort());
      expect(after.crs).not.toEqual([]);
      // (b3) the DATE that arrived with the applied half LANDED — the repair
      // offered one derivable set, so this is a write, not the whole-record
      // abort CR-CRU-086 reserves for a repair that derived nothing at all.
      expect(after.releasedAt).toBe(ANCESTRY_RELEASED_AT["0.1.0"]);
      expect(after.releasedAt).not.toBe(INGEST_MINUTE_RELEASED_AT);
      // …and the identity survived with it.
      expect(after.commit).toBe(commit);
      expect(after.timestamp).toBe(before.timestamp);
      // And the route reported a WRITE, not the whole-repair abort.
      expect(repaired.status).toBe(201);
      expect(repaired.changed).toBe(true);
    },
  );

  test(
    "AC7 + CR-CRU-086, arm (c) — OFFERED A SET, DERIVED NOTHING: a repair whose ONLY offered " +
      "set is an EMPTY packages (no crs on the post at all) leaves the WHOLE record standing — " +
      "the stored packages, the stored crs and the stored releasedAt, even though the post " +
      "carried a DIFFERENT date — and answers `changed:false`, so a caller can never tally a " +
      "write that never happened",
    async () => {
      boot();
      const key = await createProject("packages-guard-offered-nothing");
      const commit = "c".repeat(40);
      const shipped = ["CR-CRU-060", "CR-CRU-061"];
      const stored = packagesFor("0.1.2");

      expect(
        (
          await postRelease(key, {
            label: "0.1.2",
            commit,
            releasedAt: ANCESTRY_RELEASED_AT["0.1.2"]!,
            crs: shipped,
            packages: stored,
          })
        ).status,
      ).toBe(201);

      // PRE-STATE — all three provenance fields are stored and non-empty, so
      // "untouched" below cannot pass vacuously.
      const before = await onlyRelease(key);
      expect(before.releasedAt).toBe(ANCESTRY_RELEASED_AT["0.1.2"]!);
      expect(sortedCrs(before.crs)).toEqual([...shipped].sort());
      expect(before.packages).toEqual(stored);

      // The repair offers exactly ONE set — `packages` — and derives NOTHING
      // from it, while `crs` is ABSENT rather than empty: the operator-reachable
      // shape `--repair-provenance --packages ""` with no `--crs`. Arm (a)
      // covers "packages empty BESIDE a non-empty crs"; this is the cell where
      // the emptiness is all the repair brought.
      //
      // The date it carries DIFFERS from the stored one, which is what makes
      // "the whole record stood still" observable rather than a re-post of what
      // is already there — a repair that wrote nothing must not move the date
      // either, because a date is only as trustworthy as the derivation that
      // arrived with it.
      const repaired = await postRelease(key, {
        label: "0.1.2",
        commit,
        releasedAt: INGEST_MINUTE_RELEASED_AT,
        packages: [],
        repair: true,
      });

      const after = await onlyRelease(key);
      // THE DATE — asserted first, because a moved date on a repair that wrote
      // nothing is exactly the half-rewrite this cell forbids.
      expect(after.releasedAt).toBe(ANCESTRY_RELEASED_AT["0.1.2"]!);
      expect(after.releasedAt).not.toBe(INGEST_MINUTE_RELEASED_AT);
      // …and both sets with it, positively and negatively.
      expect(after.packages).toEqual(stored);
      expect(after.packages).not.toEqual([]);
      expect(sortedCrs(after.crs)).toEqual([...shipped].sort());
      expect(after.crs).not.toEqual([]);
      // WROTE NOTHING, and SAID so on the wire: `changed:false` is the only
      // thing standing between this shape and a ceremony that reports a
      // recorded release (scripts/release.sh's backfill tally) for a post that
      // changed not one byte.
      expect(repaired.changed).toBe(false);
      expect(repaired.status).toBe(200);
      // Not a second recording either — `onlyRelease` pinned the count, and
      // the row is the SAME row.
      expect(after.commit).toBe(commit);
      expect(after.timestamp).toBe(before.timestamp);
    },
  );

  // ── AC6 — payload-carried, so no migration ──────────────────────────────

  test(
    "AC6 no migration: a full packages round trip (record → read → repair → read) succeeds " +
      "against a FRESHLY booted store while that store still reports schemaVersion === 8 — " +
      "`packages` rides the generic payload blob, exactly as CR-CRU-080's provenance does",
    async () => {
      boot();
      const key = await createProject("packages-no-migration");
      const commit = "e".repeat(40);
      const atBoot = handle!.store.schemaVersion;
      const declared = packagesFor(PKG_VERSION);
      const corrected: PackageRef[] = [
        { registry: "pypi", name: "crucible-axi", version: PKG_VERSION },
      ];

      expect(
        (await postRelease(key, { label: PKG_VERSION, commit, packages: declared })).status,
      ).toBe(201);
      expect((await onlyRelease(key)).packages).toEqual(declared);

      const repaired = await postRelease(key, {
        label: PKG_VERSION,
        commit,
        packages: corrected,
        repair: true,
      });
      expect(repaired.status).toBe(201);
      // NON-VACUITY — the field genuinely round-tripped through BOTH write
      // paths, so "no migration" is a claim about a store that really stores it.
      expect((await onlyRelease(key)).packages).toEqual(corrected);

      // The design guard, a LITERAL on purpose (the queue-registration.test.ts
      // precedent): a chain step must make a human look. It FIRED for
      // CR-CRU-091 §S2, whose 7→8 step retrofits `queue_entries` with the
      // declaration columns — a legitimate, specified step that says nothing
      // about `packages`, which still rides the payload blob (asserted
      // non-vacuously above). So the tripwire's premise is superseded and it is
      // consciously RE-ARMED at 8, not disabled and not turned into a
      // tautological read of SCHEMA_VERSION.
      expect(handle!.store.schemaVersion).toBe(atBoot);
      expect(handle!.store.schemaVersion).toBe(8);
    },
  );
});
