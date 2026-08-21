// CR-CRU-074 §S4 — backfilling the releases that already shipped (RED).
//
// Spec: docs/changes/CR-CRU-074-releases-are-first-class.md §S4 + AC5/AC6.
//
//   §S4  `0.1.0`, `0.1.1`, `0.1.2` are recorded retroactively from the git
//        tags — `git tag` + `git rev-list -1 <tag>` are the authority, NEVER
//        the gate's free `intent` text — so the board is not permanently
//        missing its own release history.
//   AC5  the three shipped releases are backfilled: after the run the store
//        holds 0.1.0/0.1.1/0.1.2 with the commits THEIR TAGS point at,
//        verified against `git rev-list -1 <tag>` and idempotent (a re-run
//        converges — the server dedups on the identical identity).
//   AC6  no version is invented: the version is the tag's bare SemVer; a tag
//        that is NOT bare SemVer (a `v`-prefixed or non-release tag) is NOT
//        reported as a release.
//
// DESIGN (§S4 mechanism — orchestrator's call, spec leaves it open): a NEW
// subcommand `release.sh backfill-releases` that enumerates the repo's tags
// (`git tag`), filters to BARE SemVer (X.Y.Z), and for EACH reports a
// `release` milestone through the SAME repo-client report path §S2 built
// (`python-crucible.py milestone --type release --label <version>
// --commit <sha>`), with the commit from `git rev-list -n 1 <tag>` — never a
// gate's intent. Idempotent via server-side dedup (a re-run emits the
// identical (type,label,commit) set); warns-not-fails on a client error.
//
// TECHNIQUE — behavioural, not source-text (precedent:
// tests/release-reporting.test.ts): every test EXECUTES the real
// scripts/release.sh `backfill-releases` as a subprocess against a throwaway
// world, with `git` and the Crucible repo client both replaced by
// argv-recording STUBS. No real git, no real remote, no real Crucible server
// (port 3849), no real repo. The git stub returns a controlled tag list and a
// per-tag `rev-list` sha; the client stub records the full milestone argv, so
// WHICH versions were reported and with WHICH commit are directly observable.
//
// repo_root is redirected to the world via the stub `git rev-parse
// --show-toplevel`, so the client the command calls is the recorder placed at
// <world>/clients/<stack>-crucible.py. A recorder is placed for EVERY stack
// client so the test does not over-constrain which one GREEN wires up; the
// contract is "the repo client reported a `release` milestone", not a
// filename.
//
// RED expectation: scripts/release.sh has NO `backfill-releases` subcommand
// today (`grep backfill-releases scripts/release.sh` → nothing; the dispatch
// `*)` arm exits 2 "unknown subcommand"), so no `release` milestone is ever
// recorded. Every positive test FAILS for exactly that missing contract.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const RELEASE_SH = join(REPO_ROOT, "scripts", "release.sh");

/** The three releases that already shipped, and the commit each tag points at
 * (`git rev-list -1 <tag>`) — the authority the backfill must reproduce. */
const SHIPPED: ReadonlyArray<readonly [string, string]> = [
  ["0.1.0", "c07274c8"],
  ["0.1.1", "abc30d57"],
  ["0.1.2", "9ef24b18"],
];

/** Non-release noise a real repo also carries: a `v`-prefixed tag and a
 * non-SemVer moving tag. Neither is bare SemVer, so neither is a release. */
const NOISE_TAGS = ["v1.2.3", "nightly"];

/** Every stack's Crucible client — a recorder is dropped for each so the test
 * does not presuppose which one GREEN invokes. */
const STACK_CLIENTS = [
  "bun-crucible.py",
  "python-crucible.py",
  "rust-crucible.py",
  "mvn-crucible.py",
  "arduino-crucible.py",
];

function writeExecutable(path: string, script: string): void {
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/**
 * Stub `git`. Records every invocation to $CR074_LOG and models the git
 * surface a tag backfill drives. Knobs (env):
 *   CR074_ROOT  — what `rev-parse --show-toplevel` returns (the world root,
 *                 so repo_root resolves the client recorders).
 *   CR074_BRANCH — what `rev-parse --abbrev-ref HEAD` returns.
 *   CR074_TAGS  — space-separated tag list `git tag` enumerates.
 *
 * `rev-list -n 1 <tag>` returns the commit the TAG points at (fixed per tag,
 * so the reported commit provably comes from the tag, never from any argument
 * or gate text). An unknown tag has no commit (exit 128).
 */
const GIT_STUB = `#!/bin/sh
printf 'git %s\\n' "$*" >> "$CR074_LOG"
case "$1" in
  rev-parse)
    case "$*" in
      *--abbrev-ref*) echo "$CR074_BRANCH"; exit 0 ;;
      *--show-toplevel*) echo "$CR074_ROOT"; exit 0 ;;
      *) echo "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"; exit 0 ;;
    esac ;;
  config)
    # --get gitflow.prefix.versiontag: present-but-empty (bare tags).
    echo ""; exit 0 ;;
  tag)
    # Enumerate the repo's tags, one per line (git tag / git tag -l).
    for t in $CR074_TAGS; do echo "$t"; done
    exit 0 ;;
  describe)
    exit 128 ;;
  rev-list)
    # The last argument is the tag; map it to the commit it points at.
    for a in "$@"; do tag="$a"; done
    case "$tag" in
      0.1.0) echo "c07274c8"; exit 0 ;;
      0.1.1) echo "abc30d57"; exit 0 ;;
      0.1.2) echo "9ef24b18"; exit 0 ;;
      v1.2.3) echo "feedface11112222"; exit 0 ;;
      nightly) echo "0badcafe33334444"; exit 0 ;;
      *) exit 128 ;;
    esac ;;
  *)
    exit 0 ;;
esac
`;

/**
 * Stub Crucible client. Records its full argv to $CR074_LOG, so each release
 * report (its --type/--label/--commit) is directly observable. Exits non-zero
 * when $CR074_REPORT_FAIL="1", so warns-not-fails can be exercised.
 */
const CLIENT_STUB = `#!/usr/bin/env python3
import os, sys
with open(os.environ["CR074_LOG"], "a", encoding="utf-8") as fh:
    fh.write("client " + os.path.basename(sys.argv[0]) + " " + " ".join(sys.argv[1:]) + "\\n")
sys.exit(1 if os.environ.get("CR074_REPORT_FAIL") == "1" else 0)
`;

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Every stub invocation, in call order: `git <argv…>` / `client <name> <argv…>`. */
  log: string[];
}

interface World {
  root: string;
  run(opts?: { tags?: string[]; reportFail?: boolean }): RunResult;
  dispose(): void;
}

function makeWorld(): World {
  const root = mkdtempSync(join(tmpdir(), "cr074-backfill-"));
  const bin = join(root, "bin");
  const clients = join(root, "clients");
  const home = join(root, "home");
  const log = join(root, "argv.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(clients, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(log, "");
  writeFileSync(join(root, "package.json"), `{\n  "name": "crucible",\n  "version": "0.1.2"\n}\n`);

  writeExecutable(join(bin, "git"), GIT_STUB);
  // A curl recorder that refuses the network — proves the backfill never
  // bypasses the repo client with a bare curl to the live server.
  writeExecutable(join(bin, "curl"), `#!/bin/sh\nprintf 'curl %s\\n' "$*" >> "$CR074_LOG"\nexit 7\n`);
  for (const name of STACK_CLIENTS) writeExecutable(join(clients, name), CLIENT_STUB);

  const readLog = (): string[] =>
    readFileSync(log, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

  const pathDirs = [bin, ...(process.env.PATH ?? "").split(":").filter((d) => d.length > 0)];

  return {
    root,
    run(opts = {}): RunResult {
      const tags = opts.tags ?? SHIPPED.map(([v]) => v);
      const res = Bun.spawnSync({
        cmd: ["bash", RELEASE_SH, "backfill-releases"],
        cwd: root,
        env: {
          PATH: pathDirs.join(":"),
          HOME: home,
          SHELL: "/bin/sh",
          CR074_LOG: log,
          CR074_ROOT: root,
          CR074_BRANCH: "develop",
          CR074_TAGS: tags.join(" "),
          CR074_REPORT_FAIL: opts.reportFail ? "1" : "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        exitCode: res.exitCode,
        stdout: res.stdout.toString(),
        stderr: res.stderr.toString(),
        log: readLog(),
      };
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// log predicates
// ---------------------------------------------------------------------------

/** A repo-client invocation reporting a `release` milestone. */
const isReleaseReportLine = (l: string): boolean =>
  /^client \S+-crucible\.py\b/.test(l) && /\bmilestone\b/.test(l) && /--type\s+release\b/.test(l);

/** The `--label`/`--commit` values a release report carried, or null. */
function reportFields(line: string): { label: string | null; commit: string | null } {
  const label = line.match(/--label\s+(\S+)/);
  const commit = line.match(/--commit\s+(\S+)/);
  return { label: label ? label[1] : null, commit: commit ? commit[1] : null };
}

/** version→commit map of every release the run reported. */
function reportedIdentities(log: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of log.filter(isReleaseReportLine)) {
    const { label, commit } = reportFields(line);
    if (label !== null && commit !== null) m.set(label, commit);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let world: World;
beforeEach(() => {
  world = makeWorld();
});
afterEach(() => {
  world.dispose();
});

// ---------------------------------------------------------------------------
// AC5-a — every shipped bare-SemVer tag is backfilled with its tagged commit
// ---------------------------------------------------------------------------

describe("CR-CRU-074 §S4/AC5 — backfill-releases records every shipped release from its tag", () => {
  test("reports a release milestone for each of 0.1.0/0.1.1/0.1.2 with commit = git rev-list -1 <tag>", () => {
    const r = world.run();
    expect(r.exitCode).toBe(0);

    const reports = r.log.filter(isReleaseReportLine);
    // Exactly one release per shipped tag — not zero (today's state, no such
    // subcommand) and not a runaway (a report per git command).
    expect(reports.length).toBe(SHIPPED.length);

    // Each version carries the commit ITS TAG points at — the authority is
    // `git rev-list -1 <tag>`, so the reported commit provably comes from the
    // tag, never from an argument or a gate's intent text.
    const got = reportedIdentities(r.log);
    expect(got.get("0.1.0")).toBe("c07274c8");
    expect(got.get("0.1.1")).toBe("abc30d57");
    expect(got.get("0.1.2")).toBe("9ef24b18");

    // Reported through the repo client, never a bare curl to the live server.
    expect(r.log.some((l) => l.startsWith("curl "))).toBe(false);
  });

  test("the backfill also queries git for each tag's commit (rev-list), not a guessed value", () => {
    const r = world.run();
    // The commit's provenance is a real `git rev-list … <tag>` per shipped
    // version — the mechanism spec §S4 pins, not a value read from anywhere else.
    for (const [version] of SHIPPED) {
      const asked = r.log.some((l) => /^git rev-list\b/.test(l) && new RegExp(`\\b${version}\\b`).test(l));
      expect(asked).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// AC5-b — idempotent: a re-run converges on the identical identities
// ---------------------------------------------------------------------------

describe("CR-CRU-074 §S4/AC5 — backfill is idempotent so the store keeps one row per version", () => {
  test("a second run reports the identical (version,commit) set, so server dedup keeps one each", () => {
    const first = reportedIdentities(world.run().log);
    expect(first.size).toBe(SHIPPED.length);

    const again = makeWorld();
    try {
      const second = reportedIdentities(again.run().log);
      // The re-run emits the SAME three identities — no divergence — so the
      // server's dedup collapses each to a single row rather than appending.
      expect([...second.entries()].sort()).toEqual([...first.entries()].sort());
      expect([...second.entries()].sort()).toEqual([
        ["0.1.0", "c07274c8"],
        ["0.1.1", "abc30d57"],
        ["0.1.2", "9ef24b18"],
      ]);
    } finally {
      again.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// AC6 — no version is invented: only bare-SemVer tags become releases
// ---------------------------------------------------------------------------

describe("CR-CRU-074 §S4/AC6 — only bare-SemVer tags are reported as releases", () => {
  test("a mix of SemVer and non-SemVer tags reports ONLY the bare-SemVer ones", () => {
    // Interleave the noise so a naive iterate-all would report v1.2.3/nightly.
    const r = world.run({
      tags: ["v1.2.3", "0.1.0", "nightly", "0.1.1", "0.1.2"],
    });
    expect(r.exitCode).toBe(0);

    const got = reportedIdentities(r.log);
    // Exactly the three bare-SemVer versions, each with its tagged commit.
    expect([...got.entries()].sort()).toEqual([
      ["0.1.0", "c07274c8"],
      ["0.1.1", "abc30d57"],
      ["0.1.2", "9ef24b18"],
    ]);
    // The non-bare-SemVer tags are NOT reported as releases.
    for (const noise of NOISE_TAGS) {
      expect([...got.keys()]).not.toContain(noise);
    }
  });

  test("a repo with only non-SemVer tags backfills nothing (no release invented from noise)", () => {
    const r = world.run({ tags: [...NOISE_TAGS, "develop-latest"] });
    expect(r.exitCode).toBe(0);
    // Nothing is bare SemVer, so no release milestone is reported at all.
    expect(r.log.filter(isReleaseReportLine).length).toBe(0);
  });
});
