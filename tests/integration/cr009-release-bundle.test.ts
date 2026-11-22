// CR-CRU-009 C3 — skills-conform + arduino skill, server npm `bin`, docs
// (README/RUNBOOK), CI publish workflows (RED).
//
// Spec: docs/changes/CR-CRU-009-release-0.1.0.md
//   §S3 Skill package — Vercel-Skills-compatible, multi-harness (+ reconcile:
//       add `crucible-report-arduino`)
//   §S4 Publishing — CI-automated on release (`.github/workflows/release.yml`)
//   §S5 Docs (README quick start bootstrap + RUNBOOK)
//   §S6 Release — Test PyPI validated first, then real PyPI
//
// ESCALATION (documented, not silently substituted): the dispatch prompt asked
// for two separate CI workflow files modelled 1:1 on Sandesh
// (`.github/workflows/publish-pypi.yml` + `publish-npm.yml`). The CR spec's
// own §S4 text is explicit and singular: "Publishing is a CI workflow
// (`.github/workflows/release.yml`)". The Scope section is the authoritative
// spec text (source of truth per the AC cross-check rule), so this suite
// targets the ONE file `.github/workflows/release.yml` — carrying both the
// PyPI and npm publish stages (job-per-stage), still Sandesh-modelled in
// shape (build job, `if: github.event_name == 'release'` gated publish jobs,
// `pypa/gh-action-pypi-publish` + `id-token: write` OIDC, a Test-PyPI
// dry-run path via `workflow_dispatch` + `test.pypi.org`, and an npm publish
// step). GREEN should build this single file; if GREEN/the orchestrator
// intends two files instead, that itself would need a CR/spec amendment.
//
// RED phase: none of the asserted artifacts exist yet on this branch —
// `clients/skills/*/SKILL.md` carry no `metadata:` block, there is no
// `crucible-report-arduino` skill, root `package.json` has no `bin`, there is
// no `.github/workflows/` directory at all, and there is no `README.md` /
// `docs/RUNBOOK.md`. Every test below is expected to FAIL for one of those
// reasons — that is expected RED.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");

function readText(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

// CR-CRU-041 §S1 — Make the server package publishable
//
// Spec: docs/changes/CR-CRU-041-release-mechanism.md §S1 + Acceptance criteria
//   - package.json: no `private` field, name ==
//     "@anthill-tec/crucible-server", `publishConfig.access == "public"`, a
//     `files` whitelist (bin/, src/, public/).
//   - `npm pack --dry-run` on the resulting tarball MUST contain bin/, src/,
//     public/ and MUST NOT contain tests/, data/, crucible.db, coverage/,
//     test-reports/, test-results/, .features-gen/ — asserted by parsing the
//     real `npm pack --dry-run --json` file list, not by eyeballing it.
//
// RED phase: root package.json is currently `"private": true`, named
// unscoped `"crucible"`, with no `publishConfig` and no `files` whitelist —
// every assertion below is expected to FAIL against that state.

// WHY THE TWO `npm pack` TESTS CARRY AN EXPLICIT TIMEOUT. `npm pack` is a real
// npm invocation, and the FIRST one in a process pays npm's cold start —
// reading its own config, resolving the cache. Measured on GitHub Actions,
// 0.2.0's release branch (run 35077837163): the first of the two took 5101ms
// and blew bun's 5000ms default while the second, warm, took 2476ms and passed
// — so the pair failed on the runner and passed locally purely on machine
// speed. The budget is generous because it is NOT a performance assertion:
// nothing here claims npm is fast, only that the tarball has the right
// contents, and a bound tight enough to double as a speed check is a bound
// that reddens a release branch for the machine it ran on.
const NPM_PACK_TIMEOUT_MS = 60_000;

/** One entry of npm's own `--json` file list: the published path and the
 *  byte count npm read off disk for it. */
interface PackedFile {
  path: string;
  size: number;
}

/**
 * Runs `npm pack --dry-run --json` against the real repo package.json and
 * returns the entries npm would actually publish. Exercises the real npm
 * packaging engine (respecting `files`/`.gitignore`/.npmignore precedence,
 * and npm's own always-included set) rather than re-deriving the whitelist
 * logic by hand, so a `files` array that npm itself would ignore (typo'd
 * glob, wrong casing) still fails the test.
 */
function npmPackDryRunEntries(): PackedFile[] {
  const res = Bun.spawnSync({
    cmd: ["npm", "pack", "--dry-run", "--json"],
    cwd: REPO_ROOT,
  });
  if (res.exitCode !== 0) {
    throw new Error(`npm pack --dry-run --json failed: ${res.stderr.toString()}`);
  }
  const parsed = JSON.parse(res.stdout.toString()) as Array<{
    files?: PackedFile[];
  }> | Record<string, { files?: PackedFile[] }>;

  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  return entry?.files ?? [];
}

function npmPackDryRunFiles(): string[] {
  return npmPackDryRunEntries().map((f) => f.path);
}

describe("§S1 npm pack --dry-run tarball contents", () => {
  // CR-CRU-137 §S3/AC3 — this test says what the published package IS, so it
  // names `LICENSE` beside the runtime paths. Before this CR the tarball
  // carried no licence at all and npm's registry page rendered
  // `License: none`; a licence that ships is part of the bundle's contents,
  // not a separate concern, so it is asserted here rather than in a second
  // packing check.
  test("published tarball contains bin/, src/, public/, and LICENSE", () => {
    const files = npmPackDryRunFiles();

    // POSITIVE — the runtime paths the server actually needs (src/server.ts
    // resolves `PUBLIC_DIR` package-relative and reads package.json into
    // `pkg` for `pkg.version`; there are no runtime deps to worry about),
    // plus the licence file the registry page renders.
    for (const required of ["bin/", "src/", "public/", "LICENSE"]) {
      const present = files.some((f) => f === required || f.startsWith(required));
      expect(present).toBe(true);
    }

    // Bound: this is not "at least these three dirs exist somewhere in a
    // sprawling everything-goes tarball" — file count should be small
    // (a curated whitelist, not the whole repo).
    expect(files.length).toBeLessThan(200);
  }, NPM_PACK_TIMEOUT_MS);

  test("published tarball excludes repo working state (tests/, data/, crucible.db, coverage/, test-reports/, test-results/, .features-gen/)", () => {
    const files = npmPackDryRunFiles();

    // NEGATIVE — the point of the whitelist. A leaky `files` array that
    // falls back to shipping the whole repo (or forgets one exclusion) must
    // fail here, specifically because it would ship the dev database.
    const forbiddenPrefixes = [
      "tests/",
      "data/",
      "crucible.db",
      "coverage/",
      "test-reports/",
      "test-results/",
      ".features-gen/",
    ];

    for (const forbidden of forbiddenPrefixes) {
      const leaked = files.filter((f) => f === forbidden || f.startsWith(forbidden));
      expect(leaked).toEqual([]);
    }
  }, NPM_PACK_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// CR-CRU-137 §S3 — the published package declares its licence
//
// Spec: docs/changes/CR-CRU-137-pipeline-defaults-are-chosen-not-inherited.md
// §S3 + its three acceptance criteria. Measured on this branch before the fix:
// `package.json` carries no `license` key at all and no `LICENSE` file exists
// at the repo root, so npm serves `@anthill-tec/crucible-server` as
// `License: none` — a load-bearing declaration left to whatever the tool
// defaults to, which is this CR's whole shape.
//
// DERIVED, NOT RETYPED (§S1/AC3's principle applied to a second figure): the
// SPDX identifier is READ from `pyproject.toml`'s own `license =` declaration
// rather than restated here. The npm server package and the PyPI client
// package ship from this one repo as a version-locked pair, so two
// identifiers that disagree IS the defect — and a test that retypes the
// string cannot see that disagreement. Changing either declaration alone
// fails here.
//
// Extends this file rather than opening a new one: it is already the home of
// `package.json`'s published-identity contract (`§S1 publishable server
// package.json`) and of what the tarball contains (`§S1 npm pack --dry-run
// tarball contents`), which is exactly what §S3 adds to — and AC2 requires
// the real `npm pack --dry-run --json` mechanism this file already owns.
// ---------------------------------------------------------------------------

/** `pyproject.toml`'s own `[project] license = "<spdx>"` declaration. */
const PYPROJECT_LICENSE_PAT = /^license\s*=\s*"([^"]+)"$/m;

function declaredSpdxIdentifier(): string {
  const match = PYPROJECT_LICENSE_PAT.exec(readText("pyproject.toml"));
  if (!match) {
    throw new Error(
      'pyproject.toml declares no `license = "<spdx>"` — the identifier this ' +
        "repo's two published packages share has no single source to read.",
    );
  }
  return match[1] as string;
}

describe("CR-CRU-137 §S3 the published package declares its licence", () => {
  test("a LICENSE file at the repository root carries the full text the declared identifier names", () => {
    expect(existsSync(join(REPO_ROOT, "LICENSE"))).toBe(true);

    // The identifier selects which text belongs here, so it is read first:
    // a GPL-3.0 declaration over an MIT body is a licence that says two
    // different things.
    expect(declaredSpdxIdentifier()).toMatch(/^GPL-3\.0(-only|-or-later)$/);

    const text = readText("LICENSE");
    expect(text).toContain("GNU GENERAL PUBLIC LICENSE");
    expect(text).toContain("Version 3, 29 June 2007");

    // Bound — GPL-3.0's full text is ~35 kB. A one-line `GPL-3.0` stub, or a
    // truncated copy, is a filename, not a licence grant.
    expect(text.length).toBeGreaterThan(30_000);
  });

  test("LICENSE ships in the published npm tarball, whole, straight from the repo root", () => {
    const entries = npmPackDryRunEntries();

    // POSITIVE — read from what npm itself says it would publish, NOT from
    // package.json's `files` array: npm packs LICENSE by its own rule, so a
    // `files` read would claim coverage the tarball might not have (and miss
    // the inverse — a listed file that does not exist).
    const packed = entries.filter((f) => f.path === "LICENSE");
    expect(packed.length).toBe(1);

    // …and it is the real root file, byte for byte, not an empty or
    // truncated one that satisfies a name check.
    expect(packed[0]?.size).toBe(statSync(join(REPO_ROOT, "LICENSE")).size);
  }, NPM_PACK_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// CR-CRU-041 §S2/§S5 — release.yml trigger topology + v-prefixed tag scheme
//
// Spec: docs/changes/CR-CRU-041-release-mechanism.md §S2 + §S5 + Acceptance
// criteria.
//
// §S2 — Repair the trigger topology:
//   - on: push: branches: [develop, master] + on: pull_request (build runs
//     continuously; packaging breakage surfaces on PRs, not release day).
//   - create-release re-gated to a PUSH TO MASTER
//     (github.event_name == 'push' && github.ref == 'refs/heads/master'),
//     NOT workflow_dispatch.
//   - workflow_dispatch reserved for rehearsal ONLY: no job other than
//     publish-testpypi and dry-run-npm may be gated on workflow_dispatch —
//     this is the assertion that kills the current three-way collision
//     (create-release + publish-testpypi + dry-run-npm all firing off one
//     dispatch).
//
// §S5 — Adopt Sandesh's vX.Y.Z tag scheme (SUPERSEDED — see below):
//   - publish-pypi / publish-npm guards match ONLY v-prefixed tags
//     (^refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$); a bare 0.1.0 tag is REJECTED,
//     v0.1.0 is accepted.
//   - create-release's tag-detection grep matches ^v[0-9]+\.[0-9]+\.[0-9]+$.
//   - publish-npm KEEPS VERSION="${GITHUB_REF_NAME#v}" — still load-bearing
//     under the v-scheme (derives the bare version for the package.json
//     comparison). The earlier "drop it" item was WITHDRAWN — do not assert
//     its removal.
//
// 🚨 CR-CRU-061 §S1/§S6 SUPERSEDES §S5 above (2026-08-03). Lineage: bare
// (CR-009 §S6) -> v-prefixed (CR-041 §S5, Sandesh alignment) -> bare, FINAL
// (CR-061 §S1, user reaffirmed bare SemVer categorically). The describe
// block below now pins the FINAL bare-SemVer contract, in the SAME two guard
// sites §S5 named (publish-pypi/publish-npm refs guards + create-release's
// tag-detection grep) — direction reversed, not deleted; the original
// v-prefixed assertions this comment describes remain visible in git history
// (this file's blame) rather than being restated as live test code. The
// dead `VERSION="${GITHUB_REF_NAME#v}"` strip §S5 called load-bearing is now
// itself dead code under bare tags (a bare GITHUB_REF_NAME has no leading
// 'v' to strip) and must be swept.
//
// RED phase: on this branch release.yml's guards still match ONLY
// `^refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$` (the §S5 contract), the
// create-release grep is still `^v[0-9]+\.[0-9]+\.[0-9]+$`, and the dead
// `#v` strip is still present — every assertion below is expected to FAIL
// against that state, by design (this is the CR's own §S6 callout: this
// file "goes red the moment §S1 lands").
// ---------------------------------------------------------------------------

/**
 * The shell bodies of one job's `run:` steps, located by the job's key in the
 * parsed job graph and delivered as the YAML parser does (block scalars
 * already dedented). Empty when the job or its steps do not exist.
 */
function releaseJobRunBodies(jobs: Record<string, WorkflowJob062>, jobName: string): string[] {
  return (jobs[jobName]?.steps ?? []).flatMap((step) =>
    typeof step.run === "string" ? [step.run] : [],
  );
}

describe("§S1 release.yml bare-SemVer tag scheme (CR-CRU-061 supersedes CR-041 §S5's v-prefixed scheme)", () => {
  test("the guard regex extracted from publish-pypi accepts a bare X.Y.Z tag ref and rejects a v-prefixed or malformed one", () => {
    // Exercises the ACTUAL regex found in the file (not a hand-maintained
    // duplicate) against the exact ref shapes GitHub Actions supplies via
    // GITHUB_REF — so a guard that merely LOOKS right (e.g. an unescaped
    // 'v' left in the anchor) is still caught behaviourally. Driven as data,
    // not read off the YAML: the CI guards have no coverage today and only
    // run on a real tag push.
    const pypiShell = releaseJobRunBodies(parseReleaseWorkflowJobs062(), "publish-pypi").join("\n");

    const guardMatch = pypiShell.match(/GITHUB_REF"\s*=~\s*(\S+)\s*\]\]/);
    expect(guardMatch).not.toBeNull();
    const extractedSource = guardMatch?.[1] ?? "";

    const extractedRegex = new RegExp(extractedSource);
    // POSITIVE — the shape the release must accept.
    expect(extractedRegex.test("refs/tags/0.1.0")).toBe(true);
    // NEGATIVE — every shape §S1 must reject: v-prefixed (the superseded
    // contract), truncated, and outright junk.
    expect(extractedRegex.test("refs/tags/v0.1.0")).toBe(false);
    expect(extractedRegex.test("refs/tags/0.1")).toBe(false);
    expect(extractedRegex.test("refs/tags/junk")).toBe(false);
  });

  test("the guard regex extracted from publish-npm accepts a bare X.Y.Z tag ref and rejects a v-prefixed or malformed one", () => {
    const npmShell = releaseJobRunBodies(parseReleaseWorkflowJobs062(), "publish-npm").join("\n");

    const guardMatch = npmShell.match(/GITHUB_REF"\s*=~\s*(\S+)\s*\]\]/);
    expect(guardMatch).not.toBeNull();
    const extractedSource = guardMatch?.[1] ?? "";

    const extractedRegex = new RegExp(extractedSource);
    expect(extractedRegex.test("refs/tags/0.1.0")).toBe(true);
    expect(extractedRegex.test("refs/tags/v0.1.0")).toBe(false);
    expect(extractedRegex.test("refs/tags/0.1")).toBe(false);
    expect(extractedRegex.test("refs/tags/junk")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CR-CRU-061 §S2 — Derive the npm version from the tag (publish-npm)
//
// Spec: docs/changes/CR-CRU-061-tag-derived-versioning.md §S2 + Acceptance
// criteria: "publish-npm SETS package.json's version from the tag; a stale
// committed value no longer fails the release — asserted, including that the
// published version equals the tag" + "npm version rewrites package.json in
// the CI workspace... confirm --allow-same-version prevents a spurious
// failure when the value already matches" (Risk section).
//
// The tests below drive the extracted step body as DATA — actually
// EXECUTING the real shell fragment found in release.yml, under `bash -e`
// (matching GitHub Actions' own run-step shell, `bash --noprofile --norc -eo
// pipefail`), against a real scratch package.json — per the CR's own Risk
// section: "prefer testing the guard expressions directly... over trusting a
// read of the YAML". This proves the ACTUAL npm-version invocation found in
// the file behaves correctly, not merely that some expected string appears.
//
// UNPROVABLE WITHOUT A REAL TAG PUSH (documented, not asserted): whether this
// step actually runs on `on: release` in prod, whether `npm publish`
// afterwards picks up the just-set version, and whether npm registry
// enforcement (immutable published versions, provenance/OIDC) behaves as
// expected. Those require the real `release` event + registry, which no
// local test can exercise.
//
// RED phase: release.yml has no "npm version" step on this branch, so
// extractNpmVersionRunBody() returns "" for every test below. Each test
// therefore fails immediately on the `runBody` "npm version" containment
// assertion — not on the later "finalVersion equals tag" assertions, which
// would otherwise coincidentally pass for the same-version case. This is a
// deliberate ordering: it stops the same-version test from vacuously passing
// against an empty (no-op) script that happens to leave the version
// unchanged.
// ---------------------------------------------------------------------------

/**
 * Picks the shell body of publish-npm's version-derive step (the step whose
 * run: block invokes `npm version`) out of the job's parsed run bodies.
 * Returns "" if no such step exists yet (the pre-§S2 state on this branch).
 */
function extractNpmVersionRunBody(runBodies: string[]): string {
  return runBodies.find((body) => /npm version/.test(body)) ?? "";
}

/**
 * Actually EXECUTES the extracted step body under `bash -e` against a real
 * scratch package.json in a throwaway temp directory, injecting both
 * GITHUB_REF_NAME and VERSION as the tag (covering either naming the derive
 * step happens to use), then reports the resulting on-disk version — so the
 * assertions exercise real `npm version` behaviour rather than re-deriving
 * what it "should" do from reading text.
 */
function runNpmVersionStep(
  runBody: string,
  opts: { tag: string; initialPkgVersion: string },
): { exitCode: number | null; stderr: string; finalVersion: string | null } {
  const tmpDir = mkdtempSync(join(tmpdir(), "cr061-npm-version-"));
  try {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "scratch-pkg", version: opts.initialPkgVersion }, null, 2),
    );
    const script = `set -euo pipefail\n${runBody}\n`;
    const res = Bun.spawnSync({
      cmd: ["bash", "-c", script],
      cwd: tmpDir,
      env: {
        ...process.env,
        GITHUB_REF_NAME: opts.tag,
        VERSION: opts.tag,
      },
    });

    let finalVersion: string | null = null;
    try {
      const pkg = JSON.parse(readFileSync(join(tmpDir, "package.json"), "utf8")) as {
        version?: string;
      };
      finalVersion = pkg.version ?? null;
    } catch {
      finalVersion = null;
    }

    return { exitCode: res.exitCode, stderr: res.stderr.toString(), finalVersion };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("§S2 publish-npm derives package.json's version from the tag (driven as data)", () => {
  function getNpmVersionRunBody(): string {
    return extractNpmVersionRunBody(releaseJobRunBodies(parseReleaseWorkflowJobs062(), "publish-npm"));
  }

  test("the published version equals the tag (fresh package.json version)", () => {
    const runBody = getNpmVersionRunBody();
    // Guard: the step must actually exist and invoke npm version — without
    // this, a no-op script would leave finalVersion at initialPkgVersion,
    // which could coincidentally satisfy a weaker assertion.
    expect(runBody).toContain("npm version");

    const result = runNpmVersionStep(runBody, { tag: "3.4.5", initialPkgVersion: "0.0.0" });

    expect(result.exitCode).toBe(0);
    expect(result.finalVersion).toBe("3.4.5");
  });

  test("a stale committed package.json version (2.0.0-alpha.1, the real scaffold placeholder) no longer fails the job", () => {
    const runBody = getNpmVersionRunBody();
    expect(runBody).toContain("npm version");

    // 2.0.0-alpha.1 is package.json's actual committed version today (the
    // repo's first-commit scaffold placeholder, per the CR's own Context
    // section) — under the old verify step this diverging from any real
    // release tag would fail the job. §S2's whole point is that it no
    // longer can: the job must succeed AND end up at the tag's version, not
    // stuck at the stale one.
    const result = runNpmVersionStep(runBody, {
      tag: "5.0.0",
      initialPkgVersion: "2.0.0-alpha.1",
    });

    expect(result.exitCode).toBe(0);
    expect(result.finalVersion).toBe("5.0.0");
  });

  test("--allow-same-version: package.json already equal to the tag still succeeds (no no-op-bump failure)", () => {
    const runBody = getNpmVersionRunBody();
    expect(runBody).toContain("npm version");

    // Without --allow-same-version, `npm version <same version>` exits
    // non-zero ("Version not changed, might want --allow-same-version").
    // package.json already matching the tag must NOT fail the job.
    const result = runNpmVersionStep(runBody, {
      tag: "6.6.6",
      initialPkgVersion: "6.6.6",
    });

    expect(result.exitCode).toBe(0);
    expect(result.finalVersion).toBe("6.6.6");
  });
});

type WorkflowStep062 = { name?: string; run?: string; env?: Record<string, string> };
type WorkflowJob062 = {
  needs?: string | string[];
  if?: string;
  env?: Record<string, string>;
  steps?: WorkflowStep062[];
};
type Workflow062 = { jobs?: Record<string, WorkflowJob062> };

function parseReleaseWorkflowJobs062(): Record<string, WorkflowJob062> {
  const raw = readText(join(".github", "workflows", "release.yml"));
  const parsed = Bun.YAML.parse(raw) as Workflow062;
  return parsed.jobs ?? {};
}

// CR-CRU-062 §S5 — build/pack the SERVER artifact in CI too (RED).
//
// Spec: docs/changes/CR-CRU-062-ci-runs-the-gates.md §S5.
//
// Measured: `build` (the only unconditional, always-runs packaging job)
// packages `crucible-axi` (Python) only. The npm side publishes `bin/`,
// `src/`, `public/` straight from source with no build/pack step at all —
// the ONLY existing dry-run mechanism is the `dry-run-npm` job, and it is
// `if: github.event_name == 'workflow_dispatch'` — REHEARSAL ONLY, not run
// on every push, so a `package.json` `files`/`bin` regression would surface
// only when someone manually dispatches the rehearsal, never on an ordinary
// push — exactly the asymmetry §S5's own Context table names ("a packaging
// break on the server side surfaces only at publish time").
//
// So the behavioural bar is NOT "some job runs npm pack somewhere" (that's
// already vacuously true of dry-run-npm) — it's "an UNCONDITIONAL job does",
// matching the cadence the Python `build` job and the §S0-gated test jobs
// above already established (no event-restricting `if`).
//
// Dispatch's 🚨: consider whether asserting the packed TARBALL actually
// CONTAINS the declared bin entrypoint (`bin/crucible-server.mjs`) is
// provable in-runner. Decision: YES — `npm pack --dry-run` is a real,
// local, network-free command (verified by hand: it tars per package.json's
// `files` field, no registry contact) that runs identically here and on a
// GitHub runner, so the second test below does not merely parse the YAML —
// it EXTRACTS the real `run:` script GREEN wired up and EXECUTES it for
// real, asserting the genuine observable outcome (the entrypoint survives
// packaging) rather than "the step ran without error". This is deliberately
// NOT hardcoded to the literal string `npm pack --dry-run`: the CR text
// itself allows "or equivalent", and a hand-verified probe shows
// `npm publish --dry-run --access public` (the mechanism the pre-existing
// dry-run-npm job already uses) currently FAILS locally with "You must
// specify a tag using --tag when publishing a prerelease version" (the repo
// sits at `2.0.0-alpha.1`) — so hardcoding that exact command would either
// force GREEN into a broken mechanism or require pinning a workaround this
// RED phase has no authority to prescribe. Executing whatever GREEN
// actually wires up is what makes this test tell the truth either way.
type WorkflowStep062S5 = WorkflowStep062;

// Matches `npm pack ... --dry-run` OR `npm publish ... --dry-run` on one
// step's `run:` script — the "natural mechanism (or equivalent)" the CR
// text names, not one literal command string.
const NPM_PACK_DRYRUN_PATTERN = /\bnpm\s+(pack|publish)\b[^\n]*--dry-run/;

function findJobsMatchingRun062(
  jobs: Record<string, WorkflowJob062>,
  pattern: RegExp,
): Array<[string, WorkflowJob062]> {
  return Object.entries(jobs).filter(([, job]) =>
    (job.steps ?? []).some((s) => typeof s.run === "string" && pattern.test(s.run)),
  );
}

describe("§S5 CI builds/packs the npm server artifact too, on the same unconditional cadence as the Python `build` job", () => {
  test("the unconditional packaging step, executed for real, resolves the declared bin entrypoint (bin/crucible-server.mjs) into the tarball", () => {
    // Guard first (assertion, not a crash): an unconditional job must pack
    // before this test can extract a real script to run.
    const jobs = parseReleaseWorkflowJobs062();
    const matches = findJobsMatchingRun062(jobs, NPM_PACK_DRYRUN_PATTERN);
    const unconditional = matches.filter(([, job]) => job.if === undefined);
    expect(unconditional.length).toBeGreaterThanOrEqual(1);

    const [, job] = unconditional[0];
    const step = (job.steps ?? []).find(
      (s): s is WorkflowStep062S5 => typeof s.run === "string" && NPM_PACK_DRYRUN_PATTERN.test(s.run),
    );
    expect(step).toBeDefined();
    const script = (step as WorkflowStep062S5).run as string;

    // REAL execution — not a mock, not a re-parse of the YAML. This is the
    // exact script GREEN wrote, run against the exact repo state, on the
    // exact filesystem a GitHub runner would see (network-free: `npm pack
    // --dry-run` never contacts a registry).
    //
    // The step writes its file list to a `mktemp` file it never removes (a CI
    // runner is thrown away after the job). Here it gets a temp root of its
    // own, removed once the step has run, so the run leaves nothing behind.
    const stepTmp = mkdtempSync(join(tmpdir(), "release-pack-step-"));
    const runStep = () =>
      Bun.spawnSync(["bash", "-c", script], {
        cwd: REPO_ROOT,
        env: { ...process.env, TMPDIR: stepTmp },
        stdout: "pipe",
        stderr: "pipe",
      });
    let proc: ReturnType<typeof runStep>;
    try {
      proc = runStep();
    } finally {
      rmSync(stepTmp, { recursive: true, force: true });
    }
    const output = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;

    // POSITIVE — the real, observable outcome: the packaging command
    // succeeds AND the resolved file list names the declared bin
    // entrypoint. Catches exactly the class of breakage §S5's 🚨 names — a
    // `files`/`bin` regression in package.json that would silently stop
    // shipping the executable, since a bare "the step didn't error" check
    // would NOT catch a `files` list that quietly dropped `bin/`.
    expect(proc.exitCode).toBe(0);
    expect(output).toContain("bin/crucible-server.mjs");
  });
});
