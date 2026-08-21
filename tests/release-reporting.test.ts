// CR-CRU-074 §S2 — the release ceremony reports the shipped release to
// Crucible (RED).
//
// Spec: docs/changes/CR-CRU-074-releases-are-first-class.md §S2 + AC2/AC3/AC6.
//
//   §S2  scripts/release.sh cmd_finish reports the release through the REPO
//        client (never a bare curl). POSITION IS LOAD-BEARING: the tag is
//        CREATED by `git flow finish` but only PUBLISHED by
//        `git push origin master develop --tags`. The report fires AFTER the
//        push succeeds, so a failed push can never leave a recorded release the
//        remote never saw. A reporting failure must NOT fail the release (the
//        tag is already pushed): the ceremony warns naming the version and
//        exits 0. `--dry-run` returns before both git commands and reports
//        NOTHING.
//   AC2  reports AFTER the push, never blocks on it, dry-run records nothing.
//   AC3  idempotent — re-reporting the same version converges (no duplicate).
//   AC6  the version comes from the TAG (bare SemVer); a malformed/absent tag
//        is a reported failure, never a guessed value.
//
// TECHNIQUE — behavioural, not source-text (the precedent is
// tests/cr072-installer-upgrade.test.ts): every test EXECUTES the real
// scripts/release.sh `cmd_finish` as a subprocess against a throwaway world,
// with `git` and the Crucible repo client both replaced by argv-recording
// STUBS. No real git-flow, no real push, no real remote, no real Crucible
// server (port 3849), no real repo. The stubs append their full argv to one
// shared ordered log, so the ceremony's DECISIONS — did it report at all? did
// the report fire AFTER the push line, or before? did a dry run report
// anything? — are directly observable.
//
// repo_root is redirected to the world via the stub `git rev-parse
// --show-toplevel`, so the client the ceremony calls is the recorder placed at
// <world>/clients/<stack>-crucible.py. A recorder is placed for EVERY stack
// client so the test does not over-constrain which one GREEN wires up; the
// contract is "the repo client reported a `release` milestone", not a specific
// filename.
//
// RED expectation: scripts/release.sh has NO reporting step today
// (`grep -i crucible scripts/release.sh` → nothing), so no `release` milestone
// is ever recorded and no version-naming warning is emitted. The positive
// tests (report-after-push, idempotent identity, malformed-tag warning) FAIL
// for exactly that missing contract. The dry-run and push-failure guards are
// harness-soundness anchors and are expected to hold today.
//
// ── CR-CRU-080 (§S1 identity, §S2 loudness) ─────────────────────────────────
// Spec: docs/changes/CR-CRU-080-release-ceremony-cannot-report.md AC2/AC3/AC6.
// CR-074's mechanism above was proven against a stub client that accepted ANY
// argv, while the real client requires `--agent` and has no fallback — so every
// real release report has failed since it shipped (G1/G2). Three additions:
//   AC6  the client stub now REFUSES an argv without `--agent`, exactly as the
//        real client does, and the report's `--agent` value is asserted.
//   AC2  an absent identity is a PREFLIGHT refusal — no tag cut, no push, no
//        report attempted (`run({ agent: null })`).
//   AC3  a transport failure after the tag still exits 0, but must print a
//        single copy-pasteable recovery command carrying the tag's sha.
// The world now supplies `$CRUCIBLE_AGENT` by default, so every pre-existing
// test above exercises a ceremony that CAN report; only the AC2 tests remove it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const RELEASE_SH = join(REPO_ROOT, "scripts", "release.sh");

/** The version the ceremony is asked to finish, and the bare-SemVer tag it cuts. */
const VERSION = "0.4.0";
/** The sha the finish tag points at — what a report's `--commit` must carry. */
const TAGGED_SHA = "abc1234def5678abc1234def5678abc1234def56";

/** CR-CRU-080 §S1 — the identity the ceremony declares, sourced from the
 *  documented `$CRUCIBLE_AGENT` environment variable. */
const CEREMONY_AGENT = "release-ceremony-1";
/** CR-CRU-080 §S1 — an identity passed as `release.sh --agent <id>`, which
 *  must win over the environment fallback. */
const FLAG_AGENT = "release-ceremony-from-flag";

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
 * Stub `git`. Records every invocation to $CR074_LOG and models exactly the
 * git surface cmd_finish drives. Knobs (env):
 *   CR074_BRANCH     — what `rev-parse --abbrev-ref HEAD` returns.
 *   CR074_ROOT       — what `rev-parse --show-toplevel` returns (the world).
 *   CR074_TAG        — the tag `git flow finish` cut; empty models an ABSENT
 *                      tag (describe/rev-list then fail), non-SemVer models a
 *                      MALFORMED one.
 *   CR074_SHA        — the sha the tag points at.
 *   CR074_PUSH_FAIL  — when "1", `git push …` fails (network never touched).
 */
const GIT_STUB = `#!/bin/sh
printf 'git %s\\n' "$*" >> "$CR074_LOG"
case "$1" in
  rev-parse)
    case "$*" in
      *--abbrev-ref*) echo "$CR074_BRANCH"; exit 0 ;;
      *--show-toplevel*) echo "$CR074_ROOT"; exit 0 ;;
      *) echo "$CR074_SHA"; exit 0 ;;
    esac ;;
  config)
    # --get gitflow.prefix.versiontag: present-but-empty (exit 0, empty value).
    echo ""; exit 0 ;;
  describe)
    [ -n "$CR074_TAG" ] || exit 128
    echo "$CR074_TAG"; exit 0 ;;
  rev-list)
    [ -n "$CR074_TAG" ] || exit 128
    echo "$CR074_SHA"; exit 0 ;;
  tag)
    [ -n "$CR074_TAG" ] || exit 0
    echo "$CR074_TAG"; exit 0 ;;
  diff)
    # align_manifest_version's \`diff --cached --quiet\`: report no diff.
    exit 0 ;;
  add|commit)
    exit 0 ;;
  flow)
    # git flow <kind> finish … — the tag is cut here but NOT yet published.
    exit 0 ;;
  push)
    if [ "$CR074_PUSH_FAIL" = "1" ]; then echo "fatal: push rejected" >&2; exit 1; fi
    exit 0 ;;
  *)
    exit 0 ;;
esac
`;

/**
 * Stub Crucible client. Records its full argv to $CR074_LOG, so a report is
 * directly observable and ordered against the git push line. Exits non-zero
 * when $CR074_REPORT_FAIL="1" (Crucible unreachable / ingest failure), so the
 * ceremony's must-not-block-on-it contract can be exercised.
 *
 * CR-CRU-080 AC6 — the stub is no longer permissive. The REAL client requires
 * `--agent` and has no fallback (CR-CRU-057), so a stub that accepted any argv
 * is exactly why a ceremony that never passed an identity looked healthy here
 * for two releases. This one refuses the same way the real client does, with
 * the same error code, so the missing argument cannot pass unnoticed again.
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
    args?: string[];
    tag?: string;
    pushFail?: boolean;
    reportFail?: boolean;
    /** CR-CRU-080 §S1 — the identity in $CRUCIBLE_AGENT. `null` removes it
     *  entirely, modelling an operator with no identity available (AC2). */
    agent?: string | null;
  }): RunResult;
  dispose(): void;
}

function makeWorld(): World {
  const root = mkdtempSync(join(tmpdir(), "cr074-world-"));
  const bin = join(root, "bin");
  const clients = join(root, "clients");
  const home = join(root, "home");
  const log = join(root, "argv.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(clients, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(log, "");
  // The single manual manifest the ceremony aligns; already at VERSION so the
  // format-preserving rewrite is a genuine no-op (stub `git diff` reports none).
  writeFileSync(join(root, "package.json"), `{\n  "name": "crucible",\n  "version": "${VERSION}"\n}\n`);

  writeExecutable(join(bin, "git"), GIT_STUB);
  // A curl recorder that refuses to reach the network — proves the ceremony
  // never bypasses the repo client with a bare curl to the live server.
  writeExecutable(
    join(bin, "curl"),
    `#!/bin/sh\nprintf 'curl %s\\n' "$*" >> "$CR074_LOG"\nexit 7\n`,
  );
  for (const name of STACK_CLIENTS) writeExecutable(join(clients, name), CLIENT_STUB);

  const readLog = (): string[] =>
    readFileSync(log, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

  // Stub `git` (and `curl`) shadow the real binaries; real python3/coreutils
  // stay reachable for the manifest work and the client recorders' shebang.
  const pathDirs = [bin, ...(process.env.PATH ?? "").split(":").filter((d) => d.length > 0)];

  return {
    root,
    run(opts = {}): RunResult {
      // CR-CRU-080 §S1 — the ceremony's identity source. Supplied by default
      // so the whole pre-existing suite exercises a ceremony that CAN report;
      // the AC2 tests pass `agent: null` to remove it.
      const agent = opts.agent === undefined ? CEREMONY_AGENT : opts.agent;
      const env: Record<string, string> = {
        PATH: pathDirs.join(":"),
        HOME: home,
        SHELL: "/bin/sh",
        CR074_LOG: log,
        CR074_ROOT: root,
        CR074_BRANCH: `release/${VERSION}`,
        CR074_TAG: opts.tag ?? VERSION,
        CR074_SHA: TAGGED_SHA,
        CR074_PUSH_FAIL: opts.pushFail ? "1" : "0",
        CR074_REPORT_FAIL: opts.reportFail ? "1" : "0",
      };
      if (agent !== null) env.CRUCIBLE_AGENT = agent;
      const res = Bun.spawnSync({
        cmd: ["bash", RELEASE_SH, "finish", VERSION, ...(opts.args ?? [])],
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

const isPushLine = (l: string): boolean => /^git push\b/.test(l) && /--tags\b/.test(l);
const isFlowFinishLine = (l: string): boolean => /^git flow\b.*\bfinish\b/.test(l);

/** A repo-client invocation reporting a `release` milestone. */
const isReleaseReportLine = (l: string): boolean =>
  /^client \S+-crucible\.py\b/.test(l) && /\bmilestone\b/.test(l) && /--type\s+release\b/.test(l);

/** A git command that CREATES a tag (`git tag <name>` / `git tag -a …`) — as
 *  opposed to the read-only enumeration `git tag` with no argument. AC2's
 *  "no tag was created" is asserted against this plus the git-flow finish,
 *  which is the command that actually cuts the release tag. */
const isTagCreatingLine = (l: string): boolean => /^git tag\s+\S/.test(l);

/** The `--label`/`--commit`/`--agent` values a release report carried, or null.
 *  CR-CRU-080 AC6 — `--agent` is captured because it is REQUIRED: the whole
 *  defect was a report whose argv looked right and had no identity. */
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
// AC2 — reports AFTER the push, and never blocks on it
// ---------------------------------------------------------------------------

describe("CR-CRU-074 §S2/AC2 — the ceremony reports after the push", () => {
  test("a real finish records exactly one release milestone, after git push succeeds", () => {
    const r = world.run();
    expect(r.exitCode).toBe(0);

    const reports = r.log.filter(isReleaseReportLine);
    // Exactly one release milestone for the version — not zero (no report at
    // all, today's state) and not many (a runaway per-git-command report).
    expect(reports.length).toBe(1);

    // Load-bearing ORDER: the push line precedes the report line, so a failed
    // push can never leave a recorded release the remote never saw.
    const pushIdx = r.log.findIndex(isPushLine);
    const reportIdx = r.log.findIndex(isReleaseReportLine);
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(reportIdx).toBeGreaterThan(pushIdx);

    // The report carries the version and the tagged sha, via the repo client
    // (never a bare curl to the live server).
    const fields = reportFields(reports[0]);
    expect(fields.label).toBe(VERSION);
    expect(fields.commit).toBe(TAGGED_SHA);
    expect(r.log.some((l) => l.startsWith("curl "))).toBe(false);
  });

  test("with Crucible unreachable the release still completes, warns naming the version, and exits 0", () => {
    const r = world.run({ reportFail: true });

    // The tag is already pushed — a reporting failure must NOT fail the
    // release.
    expect(r.exitCode).toBe(0);
    expect(r.log.some(isPushLine)).toBe(true);

    // It warns, and the warning NAMES the version so the operator knows which
    // release went unrecorded.
    expect(r.stderr).toMatch(/warn/i);
    expect(r.stderr).toContain(VERSION);
  });

  test("when the push fails, NO release is reported (the report is downstream of a successful push)", () => {
    // Positive half proves the report exists at all on the happy path (fails
    // today: zero reports) — so the negative half below is a real contrast,
    // not a vacuous truth against a ceremony that never reports.
    const ok = world.run();
    expect(ok.log.filter(isReleaseReportLine).length).toBe(1);

    const bad = makeWorld();
    try {
      const r = bad.run({ pushFail: true });
      // The push failed, so the release aborted — and nothing was reported.
      expect(r.exitCode).not.toBe(0);
      expect(r.log.some(isPushLine)).toBe(true);
      expect(r.log.filter(isReleaseReportLine).length).toBe(0);
    } finally {
      bad.dispose();
    }
  });

  test("--dry-run reports nothing and makes no git mutation", () => {
    const r = world.run({ args: ["--dry-run"] });
    expect(r.exitCode).toBe(0);
    // Dry run returns before both git commands: no finish, no push, no report.
    expect(r.log.some(isFlowFinishLine)).toBe(false);
    expect(r.log.some(isPushLine)).toBe(false);
    expect(r.log.filter(isReleaseReportLine).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC3 — idempotent: re-running converges, never a second row
// ---------------------------------------------------------------------------

describe("CR-CRU-074 §S3/AC3 — re-reporting the same version converges", () => {
  test("re-running finish reports the same (type,label,commit) so the store cannot record a duplicate", () => {
    const first = world.run();
    const firstReports = first.log.filter(isReleaseReportLine);
    expect(firstReports.length).toBe(1);

    // A second world = a genuine re-run of the ceremony for the same version.
    const again = makeWorld();
    try {
      const second = again.run();
      const secondReports = second.log.filter(isReleaseReportLine);
      // The re-run reports once more, with an IDENTICAL identity — the store's
      // dedup collapses the two into one row rather than appending a second.
      expect(secondReports.length).toBe(1);
      expect(reportFields(secondReports[0])).toEqual(reportFields(firstReports[0]));
    } finally {
      again.dispose();
    }
  });

  test("a retry after a warned reporting failure re-reports the identical release, never a divergent second row", () => {
    // First attempt: report fails, ceremony warns and exits 0 (tag pushed).
    const failed = world.run({ reportFail: true });
    expect(failed.exitCode).toBe(0);

    // Retry: report succeeds. It must carry the SAME version + sha, so the
    // store converges on one row rather than two.
    const retry = makeWorld();
    try {
      const r = retry.run();
      const reports = r.log.filter(isReleaseReportLine);
      expect(reports.length).toBe(1);
      const fields = reportFields(reports[0]);
      expect(fields.label).toBe(VERSION);
      expect(fields.commit).toBe(TAGGED_SHA);
    } finally {
      retry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// AC6 — the version comes from the tag; no version is invented
// ---------------------------------------------------------------------------

describe("CR-CRU-074 §S2/AC6 — no version is invented", () => {
  test("an absent tag is a reported failure that warns, never a release guessed from the argument", () => {
    // git flow left NO usable tag (describe/rev-list fail). The version must
    // come from the tag, so the ceremony cannot fall back to the CLI argument.
    const r = world.run({ tag: "" });

    // The tag was pushed, so the reporting failure does not fail the release.
    expect(r.exitCode).toBe(0);
    // No release is recorded with the argument's value stood in for the tag.
    const guessed = r.log
      .filter(isReleaseReportLine)
      .some((l) => reportFields(l).label === VERSION);
    expect(guessed).toBe(false);
    // The operator is warned that the version could not be read from the tag.
    expect(r.stderr).toMatch(/warn/i);
    expect(r.stderr).toMatch(/tag|version/i);
  });

  test("a malformed (non-SemVer) tag is not reported as a release", () => {
    const r = world.run({ tag: "not-a-version" });
    expect(r.exitCode).toBe(0);
    // Nothing is reported carrying the malformed tag as a release version.
    const reported = r.log
      .filter(isReleaseReportLine)
      .map((l) => reportFields(l).label);
    expect(reported).not.toContain("not-a-version");
    expect(reported).not.toContain(VERSION);
    expect(r.stderr).toMatch(/warn/i);
  });
});

// ---------------------------------------------------------------------------
// CR-CRU-080 §S1/AC6 — the report DECLARES an identity
//
// Spec: docs/changes/CR-CRU-080-release-ceremony-cannot-report.md §S1 + AC1 +
// AC6. `emit_release_milestone` (scripts/release.sh:342–350) passes no
// `--agent`, and the real client requires it with no fallback (G1/G2), so every
// real release report has failed since CR-074 shipped. RED: the argv carries no
// `--agent`, so `reportFields(...).agent` is null and the stub itself refuses
// the call the way the real client does.
// ---------------------------------------------------------------------------

describe("CR-CRU-080 §S1/AC6 — the release report carries the ceremony's identity", () => {
  test("the release report's argv contains --agent with the identity from $CRUCIBLE_AGENT", () => {
    const r = world.run();
    expect(r.exitCode).toBe(0);

    const reports = r.log.filter(isReleaseReportLine);
    expect(reports.length).toBe(1);

    // POSITIVE — the exact declared identity, not merely "some --agent".
    const fields = reportFields(reports[0]);
    expect(fields.agent).toBe(CEREMONY_AGENT);
    // BOUND — the identity is an ADDITION: the version and sha still ride the
    // same call, so a GREEN that rebuilt the argv cannot drop them.
    expect(fields.label).toBe(VERSION);
    expect(fields.commit).toBe(TAGGED_SHA);
  });

  test("the identity is not invented from the role lane: $WORKFLOW_ROLE is never used as the agent id", () => {
    // CR-CRU-057's rule, restated as a non-goal in CR-CRU-080: WORKFLOW_ROLE
    // carries the track lane, not an identity. A ceremony that fell back to it
    // would plant a phantom row on the agent rail.
    const r = world.run({ agent: CEREMONY_AGENT });
    const reports = r.log.filter(isReleaseReportLine);
    expect(reports.length).toBe(1);
    expect(reportFields(reports[0]).agent).toBe(CEREMONY_AGENT);
    expect(reportFields(reports[0]).agent).not.toBe("mainline");
  });

  test("an explicit `release.sh --agent <id>` wins over the $CRUCIBLE_AGENT fallback", () => {
    // §S1: "an `--agent` flag on release.sh, FALLING BACK to a documented
    // environment variable" — so the flag is the primary source.
    const r = world.run({ args: ["--agent", FLAG_AGENT], agent: CEREMONY_AGENT });
    expect(r.exitCode).toBe(0);

    const reports = r.log.filter(isReleaseReportLine);
    expect(reports.length).toBe(1);
    expect(reportFields(reports[0]).agent).toBe(FLAG_AGENT);
    // NEGATIVE — the environment value did not leak through as well.
    expect(reportFields(reports[0]).agent).not.toBe(CEREMONY_AGENT);
  });
});

// ---------------------------------------------------------------------------
// CR-CRU-080 §S2/AC2 — no identity is a PREFLIGHT refusal, before the tag
//
// Spec §S2: "Absent identity is a preflight failure: release.sh refuses to
// start the ceremony without one, so the operator learns before the tag exists
// rather than after." RED: today the ceremony runs to completion — git flow
// finish cuts the tag, the push publishes it, and only then does the report
// fail and warn.
// ---------------------------------------------------------------------------

describe("CR-CRU-080 §S2/AC2 — a ceremony with no identity refuses at preflight", () => {
  test("finish with NO identity exits non-zero without cutting or pushing a tag", () => {
    const r = world.run({ agent: null });

    // Preflight refusal — not a warning after the fact.
    expect(r.exitCode).not.toBe(0);
    // No tag exists: git-flow finish is the command that cuts it, and nothing
    // created one directly either.
    expect(r.log.some(isFlowFinishLine)).toBe(false);
    expect(r.log.some(isTagCreatingLine)).toBe(false);
    // Nothing was published.
    expect(r.log.some(isPushLine)).toBe(false);
  });

  test("the refusal never reaches the reporting step, so nothing is posted anonymously", () => {
    const r = world.run({ agent: null });
    // Zero client invocations at all — not merely zero SUCCESSFUL reports.
    expect(r.log.filter((l) => l.startsWith("client ")).length).toBe(0);
    expect(r.log.filter(isReleaseReportLine).length).toBe(0);
  });

  test("the refusal names both identity sources so the operator can fix it in one read", () => {
    const r = world.run({ agent: null });
    const combined = `${r.stdout}\n${r.stderr}`;
    expect(combined).toMatch(/error/i);
    // POSITIVE — the exact mechanism §S1 pins: the flag and the env var.
    expect(combined).toContain("--agent");
    expect(combined).toContain("CRUCIBLE_AGENT");
  });

  test("an identity IS available → the same ceremony proceeds and publishes, so the guard is not a blanket refusal", () => {
    // Contrast case: the guard must gate on the identity, not on anything else
    // about this world.
    const r = world.run();
    expect(r.exitCode).toBe(0);
    expect(r.log.some(isFlowFinishLine)).toBe(true);
    expect(r.log.some(isPushLine)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CR-CRU-080 §S2/AC3 — a transport failure AFTER the tag prints the recovery
//
// Spec §S2/AC3: reporting stays non-fatal after publication, but "the summary
// states plainly that the release is unrecorded, with the exact recovery
// command". RED: today the ceremony warns with prose only — no command, and no
// sha to recover with.
// ---------------------------------------------------------------------------

describe("CR-CRU-080 §S2/AC3 — an unreportable published release prints its recovery command", () => {
  test("a transport failure after the tag exists still exits 0 with the tag pushed", () => {
    const r = world.run({ reportFail: true });
    expect(r.exitCode).toBe(0);
    expect(r.log.some(isPushLine)).toBe(true);
    expect(r.stderr).toMatch(/warn/i);
  });

  test("the warning carries a single copy-pasteable recovery command naming the tag's sha, version and identity", () => {
    const r = world.run({ reportFail: true });
    const combined = `${r.stdout}\n${r.stderr}`;

    // ONE line must carry the whole command — a sha printed three lines away
    // from a `milestone` mention is not a recovery command.
    const recovery = combined
      .split("\n")
      .find((l) => l.includes("milestone") && l.includes(`--commit ${TAGGED_SHA}`));
    expect(recovery).toBeDefined();
    expect(recovery!).toContain("--type release");
    expect(recovery!).toContain(`--label ${VERSION}`);
    expect(recovery!).toContain("--agent");
    expect(recovery!).toContain(CEREMONY_AGENT);
  });

  test("the summary states the release is unrecorded, so the operator cannot read the exit 0 as success", () => {
    const r = world.run({ reportFail: true });
    const combined = `${r.stdout}\n${r.stderr}`;
    expect(combined).toContain(VERSION);
    // §S2: "the summary states plainly that the release is unrecorded". Today's
    // message says only that "reporting … failed", which reads as a transient
    // hiccup rather than a release Crucible does not know about.
    expect(combined).toMatch(/not recorded|unrecorded|not reported|no release record|not in crucible/i);
  });

  test("a SUCCESSFUL report prints no recovery command, so the recovery line is a real signal", () => {
    const r = world.run();
    const combined = `${r.stdout}\n${r.stderr}`;
    // NEGATIVE half of AC3: the recovery command appears only when the report
    // actually failed.
    const recovery = combined
      .split("\n")
      .find((l) => l.includes("milestone") && l.includes(`--commit ${TAGGED_SHA}`));
    expect(recovery).toBeUndefined();
  });
});
