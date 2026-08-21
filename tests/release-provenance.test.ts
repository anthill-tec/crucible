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

/** A REAL merge commit whose SUBJECT carries the CR id — the shape §S4 matches
 *  against. The merged branch's own commit subject deliberately carries NO CR
 *  id, so a `--merges`-filtered scan and an unfiltered one agree; the fixture
 *  does not silently prefer one implementation. */
function mergeCr(repo: string, cr: string, slug: string, date: string): void {
  const branch = `feature/${cr}-${slug}`;
  git(repo, ["checkout", "-q", "-b", branch]);
  writeFileSync(join(repo, `${cr}.txt`), `work for ${cr}\n`);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "feat: work on the thing"], date);
  git(repo, ["checkout", "-q", "master"]);
  git(repo, ["merge", "-q", "--no-ff", "-m", `Merge branch '${branch}' into develop`, branch], date);
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
 */
function buildFixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "release-provenance-repo-"));
  git(repo, ["init", "-q", "-b", "master"]);
  git(repo, ["config", "user.name", "Release Fixture"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["config", "gitflow.prefix.versiontag", ""]);

  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "chore: init"], "2026-07-01T10:00:00Z");

  mergeCr(repo, "CR-CRU-041", "alpha", "2026-07-03T10:00:00Z");
  mergeCr(repo, "CR-CRU-042", "beta", "2026-07-04T10:00:00Z");
  tagRelease(repo, "0.1.0", "2026-07-10T12:00:00Z");

  mergeCr(repo, "CR-CRU-050", "gamma", "2026-07-12T10:00:00Z");
  mergeCr(repo, UNQUEUED_CR, "unqueued", "2026-07-13T10:00:00Z");
  tagRelease(repo, "0.1.1", "2026-07-15T09:30:00Z");

  mergeCr(repo, "CR-CRU-060", "delta", "2026-07-18T10:00:00Z");
  mergeCr(repo, "CR-CRU-061", "epsilon", "2026-07-19T10:00:00Z");
  tagRelease(repo, "0.1.2", "2026-07-20T16:45:00Z");

  mergeCr(repo, AFTER_LAST_TAG_CR, "after", "2026-07-25T10:00:00Z");

  // The ceremony's world, alongside the history.
  writeFileSync(join(repo, "package.json"), `{\n  "name": "crucible",\n  "version": "0.1.2"\n}\n`);
  symlinkSync(join(REPO_ROOT, "clients"), join(repo, "clients"));
  return repo;
}

const sortedCrs = (crs: string[] | undefined): string[] => [...(crs ?? [])].sort();

const byVersion = (releases: ReleaseBrief[]): Map<string, ReleaseBrief> =>
  new Map(releases.map((r) => [r.version ?? "", r]));

// ---------------------------------------------------------------------------
// A. the ceremony computes provenance from the repo it stands in
// ---------------------------------------------------------------------------

describe("the release ceremony records WHEN a release shipped and WHAT it shipped (CR-CRU-080 §S4)", () => {
  let repo: string;
  let handle: ServerHandle | undefined;
  const dbDirs: string[] = [];

  beforeAll(() => {
    repo = buildFixtureRepo();
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

  async function postJson(base: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
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

    // The world's `.env` names THIS project for the real client.
    writeFileSync(join(repo, ".env"), `CRUCIBLE_PROJECT_KEY=${key}\n`);
    return key;
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
  async function runBackfill(base: string): Promise<{ exitCode: number; output: string }> {
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

  /** One backfilled world: the ceremony has run once, cleanly, and recorded
   *  all three shipped releases. */
  async function backfilled(name: string): Promise<{ base: string; key: string; releases: ReleaseBrief[] }> {
    const base = boot();
    const key = await seedProject(base, name);
    const run = await runBackfill(base);
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

      const first = await runBackfill(base);
      expect(first.exitCode).toBe(0);
      const before = await listReleases(base, key);
      expect(before.length).toBe(3);

      const second = await runBackfill(base);
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
