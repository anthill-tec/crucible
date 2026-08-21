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
//
// ── CR-CRU-080 (§S1 identity, §S3 honest tally) ─────────────────────────────
// Spec: docs/changes/CR-CRU-080-release-ceremony-cannot-report.md AC4/AC6.
// G1: `emit_release_milestone` is the ONE reporter both this backfill and the
// ceremony share, and it passes no `--agent`, so the REAL backfill of
// 0.1.0/0.1.1/0.1.2 emitted three `agent-identity-required` errors and recorded
// nothing while this stub suite stayed green. Two additions:
//   AC6  the client stub REFUSES an argv without `--agent` (as the real client
//        does), and every per-tag report's `--agent` value is asserted.
//   AC4  a per-tag result plus a final `N/M recorded` tally, with a partial
//        failure visible in the exit SUMMARY (new `failLabel` knob fails one
//        tag's report only).
// The world supplies `$CRUCIBLE_AGENT` by default, so the pre-existing tests
// above exercise a backfill that CAN report.
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

/** CR-CRU-080 §S1 — the identity the backfill declares, sourced from the
 *  documented `$CRUCIBLE_AGENT` environment variable. */
const BACKFILL_AGENT = "release-ceremony-1";

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
 * report (its --type/--label/--commit/--agent) is directly observable. Exits
 * non-zero when $CR074_REPORT_FAIL="1", so warns-not-fails can be exercised,
 * and when the reported label matches $CR074_FAIL_LABEL, so a PARTIAL failure
 * (CR-CRU-080 AC4) can be exercised per tag.
 *
 * CR-CRU-080 AC6 — the stub is no longer permissive: the REAL client requires
 * `--agent` with no fallback (CR-CRU-057), so a stub accepting any argv is what
 * let a backfill that reported nothing look healthy here. It now refuses the
 * identical way, with the identical error code.
 */
const CLIENT_STUB = `#!/usr/bin/env python3
import os, sys
argv = sys.argv[1:]
with open(os.environ["CR074_LOG"], "a", encoding="utf-8") as fh:
    fh.write("client " + os.path.basename(sys.argv[0]) + " " + " ".join(argv) + "\\n")
if "--agent" not in argv or not argv[argv.index("--agent") + 1 :]:
    sys.stderr.write(
        "error: agent-identity-required - no agent identity was declared; "
        "supply it with \`--agent <agentId>\`. Nothing was posted.\\n"
    )
    sys.exit(2)
fail_label = os.environ.get("CR074_FAIL_LABEL", "")
if fail_label and "--label" in argv and argv[argv.index("--label") + 1] == fail_label:
    sys.stderr.write("error: connection refused\\n")
    sys.exit(1)
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
  run(opts?: {
    tags?: string[];
    reportFail?: boolean;
    /** CR-CRU-080 §S1 — the identity in $CRUCIBLE_AGENT; `null` removes it. */
    agent?: string | null;
    /** CR-CRU-080 AC4 — the ONE version whose report fails, for the partial
     *  failure the exit summary must surface. */
    failLabel?: string;
  }): RunResult;
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
      // CR-CRU-080 §S1 — the backfill's identity source, supplied by default so
      // the pre-existing suite exercises a backfill that CAN report.
      const agent = opts.agent === undefined ? BACKFILL_AGENT : opts.agent;
      const env: Record<string, string> = {
        PATH: pathDirs.join(":"),
        HOME: home,
        SHELL: "/bin/sh",
        CR074_LOG: log,
        CR074_ROOT: root,
        CR074_BRANCH: "develop",
        CR074_TAGS: tags.join(" "),
        CR074_REPORT_FAIL: opts.reportFail ? "1" : "0",
        CR074_FAIL_LABEL: opts.failLabel ?? "",
      };
      if (agent !== null) env.CRUCIBLE_AGENT = agent;
      const res = Bun.spawnSync({
        cmd: ["bash", RELEASE_SH, "backfill-releases"],
        cwd: root,
        env,
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

/** The `--label`/`--commit`/`--agent` values a release report carried, or null.
 *  CR-CRU-080 AC6 — `--agent` is captured because it is REQUIRED. */
function reportFields(line: string): {
  label: string | null;
  commit: string | null;
  agent: string | null;
} {
  const label = line.match(/--label\s+(\S+)/);
  const commit = line.match(/--commit\s+(\S+)/);
  const agent = line.match(/--agent\s+(\S+)/);
  return {
    label: label ? label[1] : null,
    commit: commit ? commit[1] : null,
    agent: agent ? agent[1] : null,
  };
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

// ---------------------------------------------------------------------------
// CR-CRU-080 §S1/AC6 — every backfilled report declares an identity
//
// Spec: docs/changes/CR-CRU-080-release-ceremony-cannot-report.md §S1 + AC6.
// `emit_release_milestone` is the SINGLE reporter shared by report_release and
// backfill-releases (G1), and it passes no `--agent`, so the real backfill run
// for 0.1.0/0.1.1/0.1.2 emitted three `agent-identity-required` errors and
// recorded nothing. RED: no report carries `--agent`.
// ---------------------------------------------------------------------------

describe("CR-CRU-080 §S1/AC6 — each backfilled release report carries the ceremony's identity", () => {
  test("every per-tag report's argv contains --agent with the identity from $CRUCIBLE_AGENT", () => {
    const r = world.run();
    const reports = r.log.filter(isReleaseReportLine);
    expect(reports.length).toBe(SHIPPED.length);

    // POSITIVE — every one of the three declares the SAME exact identity.
    expect(reports.map((l) => reportFields(l).agent)).toEqual([
      BACKFILL_AGENT,
      BACKFILL_AGENT,
      BACKFILL_AGENT,
    ]);
    // BOUND — the identity is an addition: each report still carries its own
    // version and tagged commit.
    expect([...reportedIdentities(r.log).entries()].sort()).toEqual([
      ["0.1.0", "c07274c8"],
      ["0.1.1", "abc30d57"],
      ["0.1.2", "9ef24b18"],
    ]);
  });

  test("with NO identity available the backfill refuses up front and reports nothing at all", () => {
    // §S2 makes an absent identity a PREFLIGHT failure, and the backfill shares
    // the one reporter — so it cannot spend three client calls discovering that
    // it has no identity.
    const r = world.run({ agent: null });
    expect(r.log.filter((l) => l.startsWith("client ")).length).toBe(0);
    const combined = `${r.stdout}\n${r.stderr}`;
    expect(combined).toContain("--agent");
    expect(combined).toContain("CRUCIBLE_AGENT");
  });
});

// ---------------------------------------------------------------------------
// CR-CRU-080 §S3/AC4 — per-tag result + a final tally in the exit summary
//
// Spec §S3: "`backfill-releases` reports per tag and prints a final tally
// (`3/3 recorded`, or which failed and why)." AC4 adds that a partial failure
// must be visible in the EXIT SUMMARY rather than only mid-log. RED: today the
// loop prints nothing on success and no tally at all.
// ---------------------------------------------------------------------------

/** The output lines of one stream, trimmed and non-empty. */
function lines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** The tally line (`N/M recorded`) and its position, from whichever stream the
 *  ceremony printed it on — plus that stream's other lines, so "after the last
 *  per-tag line" is a same-stream ordering claim rather than an interleave. */
function tally(r: { stdout: string; stderr: string }): { line: string; index: number; stream: string[] } | null {
  for (const stream of [lines(r.stdout), lines(r.stderr)]) {
    const index = stream.findIndex((l) => /\b\d+\/\d+\b/.test(l) && /recorded/i.test(l));
    if (index >= 0) return { line: stream[index], index, stream };
  }
  return null;
}

describe("CR-CRU-080 §S3/AC4 — the backfill reports per tag and tallies at the end", () => {
  test("a fully successful backfill names each tag it recorded and ends with a `3/3 recorded` tally", () => {
    const r = world.run();
    expect(r.exitCode).toBe(0);

    const combined = `${r.stdout}\n${r.stderr}`;
    // Per-tag result: each shipped version is named in the output.
    for (const [version] of SHIPPED) {
      expect(combined).toContain(version);
    }

    // POSITIVE — the exact tally §S3 pins.
    const t = tally(r);
    expect(t).not.toBeNull();
    expect(t!.line).toMatch(/\b3\/3\b/);

    // The tally is the SUMMARY: it comes after the last per-tag line on its own
    // stream, not buried among them.
    const lastPerTag = t!.stream.reduce(
      (acc, line, i) => (SHIPPED.some(([v]) => line.includes(v)) && i !== t!.index ? i : acc),
      -1,
    );
    expect(t!.index).toBeGreaterThan(lastPerTag);
  });

  test("a partial failure tallies `2/3` and names the failed tag in the exit summary", () => {
    const r = world.run({ failLabel: "0.1.1" });

    // Reporting stays non-fatal (a published release is never rolled back for
    // a tracking call), so the run still exits 0 — which is exactly why the
    // summary has to say what did NOT land.
    expect(r.exitCode).toBe(0);

    const t = tally(r);
    expect(t).not.toBeNull();
    // POSITIVE — two of three recorded, not a bare "done".
    expect(t!.line).toMatch(/\b2\/3\b/);
    // NEGATIVE — it must not claim all three.
    expect(t!.line).not.toMatch(/\b3\/3\b/);

    // The failed version is named at the END (in the tally line or the summary
    // block around it), not only in a warning in the middle of the log.
    const summaryBlock = t!.stream.slice(t!.index).join("\n");
    expect(summaryBlock).toContain("0.1.1");
  });

  test("the per-tag results distinguish the failure from the successes rather than warning generically", () => {
    const r = world.run({ failLabel: "0.1.1" });
    const combined = `${r.stdout}\n${r.stderr}`;

    // The two that landed and the one that did not are all named, so an
    // operator can act on the specific tag.
    expect(combined).toContain("0.1.0");
    expect(combined).toContain("0.1.2");
    expect(combined).toMatch(/0\.1\.1/);
    // The successful tags are NOT reported as failures: only the failing label
    // rides a failure/NOT-recorded line.
    const failureLines = lines(r.stdout)
      .concat(lines(r.stderr))
      .filter((l) => /fail|not recorded|NOT backfilled|unrecorded/i.test(l));
    expect(failureLines.length).toBeGreaterThan(0);
    expect(failureLines.some((l) => l.includes("0.1.1"))).toBe(true);
    expect(failureLines.some((l) => l.includes("0.1.0") || l.includes("0.1.2"))).toBe(false);
  });
});
