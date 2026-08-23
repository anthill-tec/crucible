// The release ceremony reporting against a LIVE Crucible server, through the
// REAL repo client — the invocation path a stub can never prove (RED).
//
// Spec: docs/changes/CR-CRU-080-release-ceremony-cannot-report.md §S1 (pass an
// identity) + §S3 (idempotent backfill) + AC1/AC5.
//
//   AC1  `emit_release_milestone` passes `--agent`; a release ceremony WITH an
//        identity records a `release` milestone, and `GET …/releases` returns
//        it. "Asserted against a real invocation path, not a stub that accepts
//        any argv."
//   AC5  re-running `backfill-releases` does not duplicate releases for tags
//        already recorded. Dedup is on (type, label, commit).
//
// WHY THIS FILE EXISTS (the whole point of CR-CRU-080). tests/release-*.test.ts
// prove the ceremony's SHAPE against an argv-recording stub client that accepts
// anything. The real `clients/python-crucible.py` requires `--agent` and has no
// fallback (CR-CRU-057), so every real release report has always failed while
// the stub suite stayed green. Here the ceremony calls the REAL client against
// a REAL server, so the only thing asserted is the outcome an operator sees:
// the release is in `GET …/releases`, or it is not.
//
// TECHNIQUE — same harness mechanism as tests/release-reporting.test.ts and
// tests/release-backfill.test.ts (stub `git` on PATH, a throwaway world root,
// `repo_root` redirected there via `git rev-parse --show-toplevel`), with two
// deliberate differences:
//   1. `<world>/clients` is a SYMLINK to the repo's real `clients/`, so the
//      ceremony invokes the production client, not a recorder.
//   2. the ceremony is spawned ASYNCHRONOUSLY (`Bun.spawn`, awaited). MEASURED:
//      `Bun.spawnSync` blocks the event loop, so the in-process server cannot
//      answer the client's POST and the run deadlocks until the client's
//      unbounded ingest timeout. Async spawn is load-bearing, not a style
//      choice.
//
// SAFETY: the server is in-process on an OS-assigned port (`port: 0`) over a
// per-test `mktemp` db — never port 3849 and never data/crucible.db — and is
// stopped via its own handle in `afterEach`. No real git, no real remote, no
// real push: `git` is a stub on PATH.
//
// RED expectation (measured, 2026-08-21):
//   * AC1 — `emit_release_milestone` passes no `--agent`, so the real client
//     exits 2 with `agent-identity-required` and posts NOTHING; the ceremony
//     warns and exits 0. `GET …/releases` comes back EMPTY, so every AC1
//     assertion fails on the missing contract (0 releases, not 1).
//   * AC5 — same cause first (0 releases after two backfills instead of 3);
//     once §S1 lands, the identical (type,label,commit) is posted twice and the
//     server records BOTH (G6: proven — two identical posts → two rows in
//     `GET …/releases`), so this test also fails on the missing dedup until §S3
//     lands. It passes only when identity AND dedup are both real.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerHandle } from "../src/server.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const RELEASE_SH = join(REPO_ROOT, "scripts", "release.sh");

/** The version the ceremony finishes, and the sha its tag points at. */
const VERSION = "0.4.0";
const TAGGED_SHA = "abc1234def5678abc1234def5678abc1234def56";

/** The identity the ceremony must declare (registered on the live server). */
const AGENT_ID = "release-ceremony-1";

/** The already-shipped tags the backfill replays, and each tag's commit. */
const SHIPPED: ReadonlyArray<readonly [string, string]> = [
  ["0.1.0", "c07274c8ab0000000000000000000000000000aa"],
  ["0.1.1", "abc30d5700000000000000000000000000000bb0"],
  ["0.1.2", "9ef24b1800000000000000000000000000000cc0"],
];

/** CR-CRU-084 §S1/AC1 — the two artifacts every Crucible release delivers, as
 *  the bundling strategy version-locks them: PyPI `crucible-axi` and npm
 *  `@anthill-tec/crucible-server`. The ceremony DECLARES this pair; it never
 *  verifies a publish (user ruling 2026-08-23, recorded in the CR's gap
 *  analysis D1/D3 and its Non-goals).
 *
 *  AC2 is structural and is why this takes the version as its ONLY argument:
 *  both entries are stamped from the same tag the release record is built
 *  from, so the two can never diverge and there is nothing to reconcile. */
const declaredPackages = (version: string): PackageRef[] => [
  { registry: "pypi", name: "crucible-axi", version },
  { registry: "npm", name: "@anthill-tec/crucible-server", version },
];

/** The tag's own commit date the git stub reports for `git log -1 --format=%ct`
 *  — the source CR-CRU-080 §S4 gives `releasedAt`. Pinned in 2026-06 so it can
 *  never coincide with the ingest clock, which is what makes "packages did not
 *  disturb provenance" a real comparison rather than two undefineds. */
const SHIP_DATE = Date.UTC(2026, 5, 12, 8, 15, 0) / 1000;

/** CR-CRU-084 §S1 — one delivered artifact's coordinates: WHERE it can be
 *  installed from, WHAT it is called there, and at WHICH version. */
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
  /** CR-CRU-084 §S1/§S3 — the artifacts the release DELIVERED. Absent on a
   *  pre-CR-084 release; EMPTY when the ceremony declared none. */
  packages?: PackageRef[];
}

interface ReleasesResponse {
  ok: boolean;
  releases: ReleaseBrief[];
}

interface EventBrief {
  kind: string;
  type?: string;
  label?: string;
  commit?: string;
  agentId: string;
}

interface EventsResponse {
  ok: boolean;
  events: EventBrief[];
}

/**
 * Stub `git`. Models exactly the surface `release.sh finish` and
 * `release.sh backfill-releases` drive, and records every call. Knobs (env):
 *   RSH_ROOT   — `rev-parse --show-toplevel` (the world; where clients/ lives)
 *   RSH_BRANCH — `rev-parse --abbrev-ref HEAD`
 *   RSH_TAG    — the tag `git flow finish` cut ("" models an absent tag)
 *   RSH_SHA    — the sha RSH_TAG points at
 *   RSH_TAGS   — the tag list `git tag` enumerates (the backfill's input)
 *   RSH_SHIP   — `log -1 --format=%ct <sha>`, the tag's own commit date in
 *                epoch SECONDS (CR-CRU-080 §S4's `releasedAt` source). Answered
 *                so the CR-CRU-084 tests below can prove that adding `packages`
 *                left the release's existing provenance intact (AC5) rather
 *                than comparing two absent fields.
 * `rev-list … <tag>` maps each shipped tag to ITS OWN commit, so a recorded
 * commit provably came from the tag rather than from any argument.
 */
const GIT_STUB = `#!/bin/sh
printf 'git %s\\n' "$*" >> "$RSH_LOG"
case "$1" in
  rev-parse)
    case "$*" in
      *--abbrev-ref*) echo "$RSH_BRANCH"; exit 0 ;;
      *--show-toplevel*) echo "$RSH_ROOT"; exit 0 ;;
      *) echo "$RSH_SHA"; exit 0 ;;
    esac ;;
  config)
    # --get gitflow.prefix.versiontag: present-but-empty (bare SemVer tags).
    echo ""; exit 0 ;;
  describe)
    [ -n "$RSH_TAG" ] || exit 128
    echo "$RSH_TAG"; exit 0 ;;
  log)
    echo "$RSH_SHIP"; exit 0 ;;
  tag)
    for t in $RSH_TAGS; do echo "$t"; done
    exit 0 ;;
  rev-list)
    for a in "$@"; do tag="$a"; done
    case "$tag" in
      0.1.0) echo "${SHIPPED[0][1]}"; exit 0 ;;
      0.1.1) echo "${SHIPPED[1][1]}"; exit 0 ;;
      0.1.2) echo "${SHIPPED[2][1]}"; exit 0 ;;
      *)
        if [ -n "$RSH_TAG" ] && [ "$tag" = "$RSH_TAG" ]; then echo "$RSH_SHA"; exit 0; fi
        exit 128 ;;
    esac ;;
  diff)
    # align_manifest_version's \`diff --cached --quiet\`: no diff.
    exit 0 ;;
  add|commit|flow|push)
    exit 0 ;;
  *)
    exit 0 ;;
esac
`;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  log: string[];
}

describe("the release ceremony reports through the REAL client to a LIVE server (CR-CRU-080 §S1/§S3)", () => {
  let handle: ServerHandle | undefined;
  const worlds: string[] = [];
  const dbDirs: string[] = [];

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    for (const w of worlds.splice(0)) rmSync(w, { recursive: true, force: true });
    for (const d of dbDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** An in-process server on an OS-assigned port over a throwaway on-disk db —
   *  never 3849, never data/crucible.db. Stopped by handle in afterEach. */
  function boot(): string {
    const dir = mkdtempSync(join(tmpdir(), "release-live-db-"));
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

  /** A project plus the ceremony's registered identity — the milestone route
   *  requires a live registered caller (CR-CRU-056 §S2b). */
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
    return key;
  }

  async function listReleases(base: string, key: string): Promise<ReleaseBrief[]> {
    const res = await fetch(`${base}/api/v2/projects/${key}/releases`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReleasesResponse;
    return body.releases;
  }

  async function listEvents(base: string, key: string): Promise<EventBrief[]> {
    const res = await fetch(`${base}/api/v2/events?project=${key}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as EventsResponse;
    return body.events;
  }

  /** A throwaway world whose `clients/` is the REAL repo client directory, and
   *  whose `.env` points the client at the live server's project. */
  function makeWorld(projectKey: string): { root: string; log: string } {
    const root = mkdtempSync(join(tmpdir(), "release-live-world-"));
    worlds.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const log = join(root, "argv.log");
    writeFileSync(log, "");
    writeFileSync(join(root, "package.json"), `{\n  "name": "crucible",\n  "version": "${VERSION}"\n}\n`);
    writeFileSync(join(root, ".env"), `CRUCIBLE_PROJECT_KEY=${projectKey}\n`);
    symlinkSync(join(REPO_ROOT, "clients"), join(root, "clients"));
    writeFileSync(join(bin, "git"), GIT_STUB);
    chmodSync(join(bin, "git"), 0o755);
    // A curl recorder that refuses the network: the ceremony must report
    // through the repo client, never a bare curl at the live server.
    writeFileSync(join(bin, "curl"), `#!/bin/sh\nprintf 'curl %s\\n' "$*" >> "$RSH_LOG"\nexit 7\n`);
    chmodSync(join(bin, "curl"), 0o755);
    return { root, log };
  }

  /**
   * Runs `release.sh` against the world. ASYNC on purpose: `Bun.spawnSync`
   * would block the event loop and the in-process server could never answer
   * the real client's POST.
   */
  async function runCeremony(
    base: string,
    world: { root: string; log: string },
    args: string[],
    opts: { agent?: string | null; tags?: string[]; tag?: string } = {},
  ): Promise<RunResult> {
    const agent = opts.agent === undefined ? AGENT_ID : opts.agent;
    const env: Record<string, string> = {
      PATH: [join(world.root, "bin"), ...(process.env.PATH ?? "").split(":").filter((d) => d.length > 0)].join(":"),
      HOME: join(world.root),
      SHELL: "/bin/sh",
      RSH_LOG: world.log,
      RSH_ROOT: world.root,
      RSH_BRANCH: `release/${VERSION}`,
      RSH_TAG: opts.tag ?? VERSION,
      RSH_SHA: TAGGED_SHA,
      RSH_TAGS: (opts.tags ?? SHIPPED.map(([v]) => v)).join(" "),
      RSH_SHIP: String(SHIP_DATE),
      // The real client's own contract: where the server is, and which project
      // root holds the .env carrying CRUCIBLE_PROJECT_KEY.
      CRUCIBLE_URL: base,
      PY_CRUCIBLE_PROJECT_DIR: world.root,
    };
    if (agent !== null) env.CRUCIBLE_AGENT = agent;

    const proc = Bun.spawn({
      cmd: ["bash", RELEASE_SH, ...args],
      cwd: world.root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const log = readFileSync(world.log, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return { exitCode, stdout, stderr, log };
  }

  // ── AC1 — a ceremony with an identity is a release the server returns ────

  test(
    "AC1 a finish with an identity records the release: GET …/releases returns exactly one row " +
      "carrying the tag's version and the tagged sha",
    async () => {
      const base = boot();
      const key = await seedProject(base, "live-finish");
      const world = makeWorld(key);

      const r = await runCeremony(base, world, ["finish", VERSION]);
      expect(r.exitCode).toBe(0);

      const releases = await listReleases(base, key);
      // Exactly one — not zero (today: the real client refuses the argv for
      // lack of --agent and posts nothing) and not many.
      expect(releases.length).toBe(1);
      expect(releases[0].version).toBe(VERSION);
      expect(releases[0].commit).toBe(TAGGED_SHA);
      // Reported through the repo client, never a bare curl at the server.
      expect(r.log.some((l) => l.startsWith("curl "))).toBe(false);
    },
  );

  test(
    "AC1 the recorded release is attributed to the DECLARED identity on the agent rail, " +
      "so the report reached the server as that caller rather than anonymously",
    async () => {
      const base = boot();
      const key = await seedProject(base, "live-finish-identity");
      const world = makeWorld(key);

      const r = await runCeremony(base, world, ["finish", VERSION]);
      expect(r.exitCode).toBe(0);

      const milestones = (await listEvents(base, key)).filter(
        (e) => e.kind === "milestone" && e.type === "release",
      );
      expect(milestones.length).toBe(1);
      expect(milestones[0].agentId).toBe(AGENT_ID);
      expect(milestones[0].label).toBe(VERSION);
    },
  );

  test(
    "AC1 the ceremony does not silently swallow the report: with an identity the run emits no " +
      "`NOT reported`/`failed` warning, so a recorded release and a clean run agree",
    async () => {
      const base = boot();
      const key = await seedProject(base, "live-finish-clean");
      const world = makeWorld(key);

      const r = await runCeremony(base, world, ["finish", VERSION]);
      const combined = `${r.stdout}\n${r.stderr}`;

      // The failure channel must be clean — a release that landed AND a
      // warning that it did not would mean the ceremony cannot tell.
      expect(combined).not.toMatch(/agent-identity-required/);
      expect(combined).not.toMatch(/NOT reported/i);
      expect(combined).not.toMatch(/reporting release .* failed/i);
      expect((await listReleases(base, key)).length).toBe(1);
    },
  );

  // ── AC5 — the backfill is idempotent against a live server ───────────────

  test(
    "AC5 running backfill-releases TWICE leaves exactly one release per shipped tag " +
      "(three rows, no version recorded twice)",
    async () => {
      const base = boot();
      const key = await seedProject(base, "live-backfill-idempotent");
      const world = makeWorld(key);

      const first = await runCeremony(base, world, ["backfill-releases"]);
      expect(first.exitCode).toBe(0);
      const second = await runCeremony(base, world, ["backfill-releases"]);
      expect(second.exitCode).toBe(0);

      const releases = await listReleases(base, key);
      // POSITIVE: the three shipped versions, once each.
      expect([...releases.map((r) => r.version)].sort()).toEqual(["0.1.0", "0.1.1", "0.1.2"]);
      // BOUND: exactly three rows — six would be the un-deduped re-run (G6).
      expect(releases.length).toBe(3);
    },
  );

  test(
    "AC5 the re-run preserves each release's tagged commit, so dedup is on (type,label,commit) " +
      "and not a blind overwrite",
    async () => {
      const base = boot();
      const key = await seedProject(base, "live-backfill-commits");
      const world = makeWorld(key);

      await runCeremony(base, world, ["backfill-releases"]);
      await runCeremony(base, world, ["backfill-releases"]);

      const byVersion = new Map((await listReleases(base, key)).map((r) => [r.version, r.commit]));
      expect(byVersion.size).toBe(3);
      for (const [version, sha] of SHIPPED) {
        expect(byVersion.get(version)).toBe(sha);
      }
    },
  );

  test(
    "AC5 a backfill whose tag list also carries non-SemVer noise records only the three releases, " +
      "and a re-run still adds nothing",
    async () => {
      const base = boot();
      const key = await seedProject(base, "live-backfill-noise");
      const world = makeWorld(key);
      const tags = ["v1.2.3", "0.1.0", "nightly", "0.1.1", "0.1.2"];

      await runCeremony(base, world, ["backfill-releases"], { tags });
      const afterFirst = await listReleases(base, key);
      expect(afterFirst.length).toBe(3);

      await runCeremony(base, world, ["backfill-releases"], { tags });
      const afterSecond = await listReleases(base, key);
      expect(afterSecond.length).toBe(3);
      expect(afterSecond.map((r) => r.version).sort()).toEqual(["0.1.0", "0.1.1", "0.1.2"]);
      expect(afterSecond.map((r) => r.version)).not.toContain("v1.2.3");
      expect(afterSecond.map((r) => r.version)).not.toContain("nightly");
    },
  );

  // ── CR-CRU-084 §S1/AC1/AC2 — `finish` DECLARES the delivered packages ────
  //
  // Spec: docs/changes/CR-CRU-084-release-records-its-packages.md §S1 (capture
  // at `finish`, through the existing single reporter) + AC1 (two entries,
  // each naming registry, package name and version) + AC2 (every entry's
  // version IS the release version, structurally).
  //
  // The server half shipped in C1 (`PackageRef` + `packages` carried verbatim
  // by `handleMilestones` and exposed by `releaseBrief`), and is proven at the
  // wire in tests/release-provenance.test.ts section F. What is missing is the
  // ACTOR: nothing between `report_release` and the client ever declares a
  // package, so the field the route would happily carry is never sent.
  //
  // RED expectation (measured, 2026-08-23):
  //   * `emit_release_milestone` (scripts/release.sh:620-644) builds its argv
  //     from `--released-at`/`--crs`/`--repair-provenance` only — `grep -c
  //     packages scripts/release.sh` is 0 — so the post carries no packages.
  //   * even if it did, no client accepts the flag: the `milestone` subparser
  //     is duplicated five times (bun:1978, mvn:1959, python:1434, rust:2495,
  //     arduino:1104) and none declares `--packages`, so argparse would exit 2
  //     on an unrecognised argument.
  // Both assertions below therefore fail on `packages` being `undefined` — the
  // missing contract, not a broken fixture.

  test(
    "AC1 a finish declares the release's TWO delivered packages — PyPI crucible-axi and npm " +
      "@anthill-tec/crucible-server — and the release keeps the releasedAt the same run " +
      "computed, so packages ride ALONGSIDE provenance rather than displacing it",
    async () => {
      const base = boot();
      const key = await seedProject(base, "live-finish-packages");
      const world = makeWorld(key);

      const r = await runCeremony(base, world, ["finish", VERSION]);
      expect(r.exitCode).toBe(0);
      // The ceremony's own argv must stay clean: an unknown flag would make
      // every assertion below fail for the wrong reason.
      expect(`${r.stdout}\n${r.stderr}`).not.toMatch(/unrecognized arguments/);

      const releases = await listReleases(base, key);
      expect(releases.length).toBe(1);
      const rel = releases[0]!;

      // AC1 — the declared pair, in the order declared, each entry complete.
      expect(rel.packages).toEqual(declaredPackages(VERSION));
      // …spelled out, so a future edit that keeps two entries but loses a
      // registry or renames an artifact cannot slip through the deep-equal.
      expect(rel.packages!.map((p) => p.registry)).toEqual(["pypi", "npm"]);
      expect(rel.packages!.map((p) => p.name)).toEqual([
        "crucible-axi",
        "@anthill-tec/crucible-server",
      ]);

      // AC5 / no provenance regression — the release still carries what
      // CR-CRU-080 §S4 gave it. `releasedAt` is the tag's own commit date the
      // ceremony read from git in THIS run, not the ingest clock.
      expect(rel.releasedAt).toBe(SHIP_DATE);
      expect(rel.timestamp).not.toBe(SHIP_DATE);
      expect(rel.version).toBe(VERSION);
      expect(rel.commit).toBe(TAGGED_SHA);
      // Still reported through the repo client, never a bare curl or a `gh`
      // call at a registry — declaring is not verifying (§S1, Non-goals).
      expect(r.log.some((l) => l.startsWith("curl "))).toBe(false);
    },
  );

  test(
    "AC2 structurally: driven at a TAG that differs from the version on the command line, both " +
      "declared packages carry the TAG's version — the same value the release record itself is " +
      "built from — and no per-registry version is supplied anywhere in the invocation",
    async () => {
      const base = boot();
      const key = await seedProject(base, "live-finish-packages-are-the-tag");
      const world = makeWorld(key);

      // The tag `git flow finish` actually cut, deliberately NOT the argument
      // the operator typed. `report_release` reads the tag (`git describe`),
      // so the recorded release is 0.7.1 while the CLI said 0.4.0 — which is
      // what makes "the version IS the tag" falsifiable rather than a
      // tautology satisfied by echoing the argument back.
      const TAG = "0.7.1";
      expect(TAG).not.toBe(VERSION);

      const argv = ["finish", VERSION];
      const r = await runCeremony(base, world, argv, { tag: TAG });
      expect(r.exitCode).toBe(0);

      const releases = await listReleases(base, key);
      expect(releases.length).toBe(1);
      const rel = releases[0]!;

      // The release record itself is built from the tag…
      const recorded = rel.version!;
      expect(recorded).toBe(TAG);
      // …and every declared package's version is that SAME value.
      expect(rel.packages).toBeDefined();
      expect(rel.packages!.length).toBe(2);
      for (const pkg of rel.packages!) {
        expect(pkg.version).toBe(recorded);
        expect(pkg.version).toBe(TAG);
        expect(pkg.version).not.toBe(VERSION);
      }

      // NO SEPARATE VERSION INPUT: the whole invocation is the subcommand and
      // one version, and no argument names a registry or a per-artifact
      // version. There is nothing for the two entries to diverge from.
      expect(argv).toEqual(["finish", VERSION]);
      expect(argv.some((a) => /^--(pypi|npm|package|packages|artifact)/.test(a))).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// CR-CRU-084 §S1 / Non-goals — the ceremony DECLARES; it never VERIFIES.
//
// The user ruling of 2026-08-23 (recorded in the CR's gap analysis D1/D3) is
// the whole reason `packages` can be captured at `finish` at all: at record
// time no artifact exists yet — `cmd_finish` pushes the tag and reports
// immediately, while `publish-pypi`/`publish-npm` run afterwards in CI. So the
// pair is a DECLARATION, and the gate ladder before `finish` is the assurance.
//
// That makes "no publish verification" a load-bearing NEGATIVE: the moment a
// well-meaning change adds `gh run view` or a registry probe to the reporting
// path, the ceremony acquires a network-and-CI dependency it must not have,
// and a published tag becomes blockable by its own report. A negative is not
// observable from a passing run, so it is pinned against the script text —
// the honest instrument for it — with a POSITIVE CONTROL proving the reader
// actually bites (`cmd_checkpoint` legitimately shells out to `gh`, and the
// same reader must find it there).
//
// RED expectation (measured, 2026-08-23): the coordinates are asserted to be
// PRESENT in the script and are not — `grep -c 'crucible-axi\|anthill-tec'
// scripts/release.sh` is 0 — so the declaration half fails today while the
// prohibition half already holds and must keep holding.
describe("the ceremony declares the delivered pair WITHOUT consulting CI or a registry (CR-CRU-084 §S1/Non-goals)", () => {
  const SOURCE = readFileSync(RELEASE_SH, "utf8");

  /** The body of a top-level bash function `name() {` … `}` in `source`, with
   *  comment-only lines removed. `release.sh` writes every function opener and
   *  its closing brace in column 0, which is what makes this exact rather than
   *  a heuristic — and `bashFunctions()` below asserts that premise. */
  function bashFunctionBody(source: string, name: string): string | undefined {
    const lines = source.split("\n");
    const start = lines.findIndex((l) => l === `${name}() {`);
    if (start < 0) return undefined;
    const end = lines.findIndex((l, i) => i > start && l === "}");
    if (end < 0) return undefined;
    return lines
      .slice(start + 1, end)
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
  }

  /** Every top-level function the script defines, by name. */
  function bashFunctions(source: string): string[] {
    return source
      .split("\n")
      .map((l) => /^([A-Za-z_][A-Za-z0-9_]*)\(\) \{$/.exec(l)?.[1])
      .filter((n): n is string => n !== undefined);
  }

  /**
   * The RELEASE-REPORTING PATH: `report_release` and the backfill, everything
   * `emit_release_milestone` reaches to compute what it posts, and — the
   * future-proofing clause — ANY function whose name mentions a package, so a
   * helper added by the GREEN phase is covered without this list naming it and
   * without pinning what that helper must be called or whether it exists.
   */
  const REPORTING_PATH = [
    "report_release",
    "emit_release_milestone",
    "cmd_backfill_releases",
    "release_ship_date",
    "release_tags",
    "release_crs",
    "earliest_tag_containing",
    "plan_merge_map",
    "queue_read",
    "report_unplaceable_crs",
    ...bashFunctions(SOURCE).filter((n) => /pack/i.test(n)),
  ];

  /** Shelling out to CI, or to a registry, from the reporting path. Matched as
   *  COMMANDS, never as bare words: the registry IDS `pypi` and `npm` are
   *  exactly what a declaration must contain, so a word-level ban would forbid
   *  the very thing AC1 requires. */
  const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
    ["the gh CLI", /(^|[\s;|&(`$])gh\s/m],
    ["curl", /(^|[\s;|&(`$])curl\s/m],
    ["wget", /(^|[\s;|&(`$])wget\s/m],
    ["an npm registry read", /(^|[\s;|&(`$])npm\s+(view|info|show|dist-tag|ping)/m],
    ["a pip registry read", /(^|[\s;|&(`$])pip3?\s+(index|download|install)/m],
    ["pypi.org", /pypi\.org/],
    ["the npm registry host", /npmjs\.(org|com)/],
    ["the GitHub API host", /api\.github\.com/],
  ];

  test(
    "the reader BITES: cmd_checkpoint really does shell out to `gh`, and the same extractor " +
      "finds it there — so a clean reporting path below is a measurement, not a broken regex",
    () => {
      const checkpoint = bashFunctionBody(SOURCE, "cmd_checkpoint");
      expect(checkpoint).toBeDefined();
      expect(FORBIDDEN[0]![1].test(checkpoint!)).toBe(true);
      // …and the function list the sweep is built from is real, not empty.
      expect(bashFunctions(SOURCE)).toContain("emit_release_milestone");
      for (const name of REPORTING_PATH) {
        expect(bashFunctionBody(SOURCE, name)).toBeDefined();
      }
    },
  );

  test(
    "no function on the release-reporting path consults CI or a registry: no gh, no curl/wget, " +
      "no `npm view`/`pip index`, and no pypi.org/npmjs/api.github.com host anywhere in it",
    () => {
      const offenders: string[] = [];
      for (const name of REPORTING_PATH) {
        const body = bashFunctionBody(SOURCE, name)!;
        for (const [what, pattern] of FORBIDDEN) {
          if (pattern.test(body)) offenders.push(`${name}: ${what}`);
        }
      }
      expect(offenders).toEqual([]);
    },
  );

  test(
    "and the pair it declares is version-locked COORDINATES held in the ceremony itself: the " +
      "script names PyPI crucible-axi and npm @anthill-tec/crucible-server, so what is recorded " +
      "comes from the declaration rather than from a lookup",
    () => {
      expect(SOURCE).toContain("crucible-axi");
      expect(SOURCE).toContain("@anthill-tec/crucible-server");
    },
  );
});
