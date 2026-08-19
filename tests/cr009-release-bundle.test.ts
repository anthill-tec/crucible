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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

function readText(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

// ---------------------------------------------------------------------------
// §S2/§S4 — server npm `bin` (npx-runnable, publishable server identity)
// ---------------------------------------------------------------------------

describe("§S4 server npm bin (npx-runnable)", () => {
  test("package.json declares a bin mapping to an existing server entry file", () => {
    const pkg = JSON.parse(readText("package.json")) as {
      name?: string;
      bin?: string | Record<string, string>;
    };

    expect(pkg.bin).toBeDefined();

    const entries: Array<[string, string]> =
      typeof pkg.bin === "string"
        ? [[pkg.name ?? "unknown", pkg.bin]]
        : Object.entries(pkg.bin as Record<string, string>);

    expect(entries.length).toBeGreaterThan(0);

    for (const [binName, binTarget] of entries) {
      expect(typeof binTarget).toBe("string");
      expect(binTarget.length).toBeGreaterThan(0);
      const resolved = join(REPO_ROOT, binTarget);
      expect(existsSync(resolved)).toBe(true);

      // Must be real wiring to the server entry, not an empty/no-op stub.
      const binContent = readFileSync(resolved, "utf8");
      expect(binContent.length).toBeGreaterThan(0);
      expect(binContent).toMatch(/server(\.ts|\.js)?/);
      expect(binName.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// §S4/§S6 — CI publish workflow (Sandesh-modelled shape, single release.yml
// per the CR's own §S4 text — see ESCALATION note at top of file)
// ---------------------------------------------------------------------------

describe("§S4/§S6 CI publish workflow (.github/workflows/release.yml)", () => {
  const relPath = join(".github", "workflows", "release.yml");

  test("release.yml exists and is valid YAML with an on.release.published + workflow_dispatch trigger", () => {
    expect(existsSync(join(REPO_ROOT, relPath))).toBe(true);

    const raw = readText(relPath);
    const parsed = Bun.YAML.parse(raw) as {
      on?: {
        release?: { types?: string[] };
        workflow_dispatch?: unknown;
      };
      jobs?: Record<string, unknown>;
    };

    expect(parsed.on).toBeDefined();
    expect(parsed.on?.release).toBeDefined();
    expect(parsed.on?.release?.types).toContain("published");

    // Manual Test-PyPI / dry-run path (§S6: "validated against Test PyPI
    // first"), same trigger shape as Sandesh's publish-pypi.yml.
    expect(parsed.on).toHaveProperty("workflow_dispatch");

    expect(parsed.jobs).toBeDefined();
    expect(Object.keys(parsed.jobs as Record<string, unknown>).length).toBeGreaterThanOrEqual(2);
  });

  test("release.yml gates the real publish job(s) on the release event only", () => {
    const raw = readText(relPath);
    const gatedOnRelease = raw.match(/if:\s*.*github\.event_name\s*==\s*'release'/g) ?? [];
    // Bounded: at least one gated publish job, but not an unbounded number of
    // matches that would suggest the guard was pasted onto every job
    // (including e.g. the build/test job, which must run unconditionally).
    expect(gatedOnRelease.length).toBeGreaterThanOrEqual(1);
    expect(gatedOnRelease.length).toBeLessThanOrEqual(4);
  });

  test("release.yml publishes to PyPI via Trusted Publishing (OIDC) with a Test-PyPI dry-run path", () => {
    const raw = readText(relPath);
    expect(raw).toContain("pypa/gh-action-pypi-publish");
    expect(raw).toMatch(/id-token:\s*write/);
    expect(raw).toContain("test.pypi.org");
  });

  test("release.yml publishes the bun/node server package to npm", () => {
    const raw = readText(relPath);
    expect(raw).toMatch(/npm publish/);
  });
});

// ---------------------------------------------------------------------------
// §S5 — Docs (README quick-start bootstrap + RUNBOOK)
// ---------------------------------------------------------------------------

describe("§S5 docs — README quick start", () => {
  test("README.md exists with the one-line curl|sh bootstrap quick start", () => {
    expect(existsSync(join(REPO_ROOT, "README.md"))).toBe(true);

    const readme = readText("README.md");
    // §S1: `curl -fsSL <crucible>/install.sh | sh`
    expect(readme).toMatch(/curl\s+-fsSL\s+\S*install\.sh\s*\|\s*sh/);
    expect(readme).toContain("uv");
    expect(readme).toContain("crucible-axi");
  });
});

describe("§S5 docs — RUNBOOK", () => {
  test("docs/RUNBOOK.md exists with start/stop + port/bind config", () => {
    expect(existsSync(join(REPO_ROOT, "docs", "RUNBOOK.md"))).toBe(true);

    const runbook = readText(join("docs", "RUNBOOK.md"));
    const lower = runbook.toLowerCase();

    expect(lower).toContain("start");
    expect(lower).toContain("stop");

    // §S1/S2: loopback-only default, CRUCIBLE_PORT / CRUCIBLE_HOST config
    // (real env var names, read from src/server.ts).
    expect(runbook).toContain("CRUCIBLE_PORT");
    expect(runbook).toContain("CRUCIBLE_HOST");
    expect(lower).toMatch(/127\.0\.0\.1|loopback/);
  });

  test("docs/RUNBOOK.md documents corrupt-db recovery (moves aside + fresh boot)", () => {
    const runbook = readText(join("docs", "RUNBOOK.md"));
    const lower = runbook.toLowerCase();

    // §S5: corrupt-db behavior — the real src/store.ts Store.open path.
    expect(lower).toContain("corrupt");
    // Documents the aside-rename pattern (<path>.corrupt-<epoch>) accurately.
    expect(runbook).toMatch(/\.corrupt-<?epoch>?/i);
  });

  test("docs/RUNBOOK.md documents retention (default 100 + override knob)", () => {
    const runbook = readText(join("docs", "RUNBOOK.md"));
    const lower = runbook.toLowerCase();

    // §S5: retention — real src/store.ts DEFAULT_RETENTION = 100, overridable
    // via project.retention.
    expect(lower).toContain("retention");
    expect(runbook).toContain("100");
  });
});

// ---------------------------------------------------------------------------
// §S1 — install.sh bootstrap (the one-line curl … | sh entrypoint)
// ---------------------------------------------------------------------------

describe("§S1 install.sh bootstrap", () => {
  test("install.sh exists at repo root as a shell script", () => {
    expect(existsSync(join(REPO_ROOT, "install.sh"))).toBe(true);

    const script = readText("install.sh");
    // A real shell script leads with a shebang.
    expect(script).toMatch(/^#!\s*\/(usr\/)?bin\/(env\s+)?sh/);
  });

  test("install.sh implements the §S1 uv → crucible-axi flow", () => {
    const script = readText("install.sh");

    // Ensures uv is present (checked, and installed via Astral's canonical
    // bootstrap when absent).
    expect(script).toContain("uv");
    expect(script).toMatch(/command\s+-v\s+uv/);
    expect(script).toContain("astral.sh/uv/install.sh");

    // Installs the PyPI primary orchestrator.
    expect(script).toContain("uv tool install crucible-axi");
  });
});

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

/**
 * Runs `npm pack --dry-run --json` against the real repo package.json and
 * returns the flat list of file paths npm would actually publish. Exercises
 * the real npm packaging engine (respecting `files`/`.gitignore`/.npmignore
 * precedence) rather than re-deriving the whitelist logic by hand, so a
 * `files` array that npm itself would ignore (typo'd glob, wrong casing)
 * still fails the test.
 */
function npmPackDryRunFiles(): string[] {
  const res = Bun.spawnSync({
    cmd: ["npm", "pack", "--dry-run", "--json"],
    cwd: REPO_ROOT,
  });
  if (res.exitCode !== 0) {
    throw new Error(`npm pack --dry-run --json failed: ${res.stderr.toString()}`);
  }
  const parsed = JSON.parse(res.stdout.toString()) as Array<{
    files?: Array<{ path: string }>;
  }> | Record<string, { files?: Array<{ path: string }> }>;

  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  const files = entry?.files ?? [];
  return files.map((f) => f.path);
}

describe("§S1 publishable server package.json", () => {
  test("package.json has no private field (or false), scoped public name, and publishConfig.access", () => {
    const pkg = JSON.parse(readText("package.json")) as {
      name?: string;
      private?: boolean;
      publishConfig?: { access?: string };
    };

    // POSITIVE — exact required values, not mere presence.
    expect(pkg.private).not.toBe(true);
    expect(pkg.name).toBe("@anthill-tec/crucible-server");
    expect(pkg.publishConfig).toBeDefined();
    expect(pkg.publishConfig?.access).toBe("public");
  });

  test("package.json declares a files whitelist covering bin/, src/, public/", () => {
    const pkg = JSON.parse(readText("package.json")) as { files?: string[] };

    expect(Array.isArray(pkg.files)).toBe(true);
    const files = pkg.files as string[];
    expect(files.length).toBeGreaterThan(0);

    // Each required runtime path must be covered by some whitelist entry
    // (exact dir entry like "bin/" or a "bin/**" style glob).
    for (const required of ["bin", "src", "public"]) {
      const covered = files.some((f) => f === required || f.startsWith(`${required}/`));
      expect(covered).toBe(true);
    }
  });
});

describe("§S1 npm pack --dry-run tarball contents", () => {
  test("published tarball contains bin/, src/, and public/", () => {
    const files = npmPackDryRunFiles();

    // POSITIVE — the runtime paths the server actually needs (src/server.ts
    // resolves PUBLIC_DIR package-relative and reads package.json for
    // pkg.version at :92/:15; there are no runtime deps to worry about).
    for (const required of ["bin/", "src/", "public/"]) {
      const present = files.some((f) => f === required || f.startsWith(required));
      expect(present).toBe(true);
    }

    // Bound: this is not "at least these three dirs exist somewhere in a
    // sprawling everything-goes tarball" — file count should be small
    // (a curated whitelist, not the whole repo).
    expect(files.length).toBeLessThan(200);
  });

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
  });
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

type ReleaseWorkflow = {
  on?: {
    push?: { branches?: string[] };
    pull_request?: unknown;
    release?: { types?: string[] };
    workflow_dispatch?: unknown;
  };
  jobs?: Record<string, { if?: string }>;
};

function readReleaseWorkflow(): { raw: string; parsed: ReleaseWorkflow } {
  const relPath = join(".github", "workflows", "release.yml");
  const raw = readText(relPath);
  const parsed = Bun.YAML.parse(raw) as ReleaseWorkflow;
  return { raw, parsed };
}

describe("§S2 release.yml trigger topology", () => {
  test("on.push.branches includes both develop and master", () => {
    const { parsed } = readReleaseWorkflow();

    expect(parsed.on?.push).toBeDefined();
    expect(Array.isArray(parsed.on?.push?.branches)).toBe(true);
    const branches = parsed.on?.push?.branches as string[];

    expect(branches).toContain("develop");
    expect(branches).toContain("master");
  });

  test("on declares a pull_request trigger", () => {
    const { parsed } = readReleaseWorkflow();
    expect(parsed.on).toHaveProperty("pull_request");
  });

  test("create-release is gated on a push to master, not on workflow_dispatch", () => {
    const { parsed } = readReleaseWorkflow();
    const createRelease = parsed.jobs?.["create-release"];
    expect(createRelease).toBeDefined();
    expect(typeof createRelease?.if).toBe("string");

    const cond = createRelease?.if as string;
    // POSITIVE — exact required guard.
    expect(cond).toContain("github.event_name == 'push'");
    expect(cond).toContain("github.ref == 'refs/heads/master'");
    // NEGATIVE — must NOT still be gated on workflow_dispatch.
    expect(cond).not.toContain("workflow_dispatch");
  });

  test("workflow_dispatch is rehearsal-only: no job other than publish-testpypi and dry-run-npm is gated on it", () => {
    const { parsed } = readReleaseWorkflow();
    const jobs = parsed.jobs as Record<string, { if?: string }>;
    expect(jobs).toBeDefined();

    const allowed = new Set(["publish-testpypi", "dry-run-npm"]);
    const gatedOnDispatch = Object.entries(jobs)
      .filter(([, job]) => typeof job.if === "string" && job.if.includes("workflow_dispatch"))
      .map(([name]) => name);

    // Bound: exactly the two rehearsal jobs, nothing else (kills the
    // three-way collision where create-release also fired on dispatch).
    for (const name of gatedOnDispatch) {
      expect(allowed.has(name)).toBe(true);
    }
    expect(gatedOnDispatch).toContain("publish-testpypi");
    expect(gatedOnDispatch).toContain("dry-run-npm");
    expect(gatedOnDispatch.length).toBe(2);
  });
});

describe("§S1 release.yml bare-SemVer tag scheme (CR-CRU-061 supersedes CR-041 §S5's v-prefixed scheme)", () => {
  const BARE_TAG_REGEX_SOURCE = "^refs/tags/[0-9]+\\.[0-9]+\\.[0-9]+$";

  test("publish-pypi guard matches only bare X.Y.Z tag refs (regex text), not v-prefixed", () => {
    const { raw } = readReleaseWorkflow();

    // Isolate the publish-pypi job body so we don't accidentally match
    // publish-npm's identical guard text.
    const pypiJobMatch = raw.match(/publish-pypi:[\s\S]*?(?=\n {2}\S|\n$)/);
    expect(pypiJobMatch).not.toBeNull();
    const pypiJob = pypiJobMatch?.[0] ?? "";

    expect(pypiJob).toContain(BARE_TAG_REGEX_SOURCE);
    // NEGATIVE — the superseded v-prefixed pattern must be gone from this job.
    expect(pypiJob).not.toContain("^refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+$");
  });

  test("publish-npm guard matches only bare X.Y.Z tag refs (regex text), not v-prefixed", () => {
    const { raw } = readReleaseWorkflow();

    const npmJobMatch = raw.match(/publish-npm:[\s\S]*?(?=\n {2}\S|\n$)/);
    expect(npmJobMatch).not.toBeNull();
    const npmJob = npmJobMatch?.[0] ?? "";

    expect(npmJob).toContain(BARE_TAG_REGEX_SOURCE);
    expect(npmJob).not.toContain("^refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+$");
  });

  test("the guard regex extracted from publish-pypi accepts a bare X.Y.Z tag ref and rejects a v-prefixed or malformed one", () => {
    // Exercises the ACTUAL regex found in the file (not a hand-maintained
    // duplicate) against the exact ref shapes GitHub Actions supplies via
    // GITHUB_REF — so a guard that merely LOOKS right (e.g. an unescaped
    // 'v' left in the anchor) is still caught behaviourally. Driven as data,
    // not read off the YAML: the CI guards have no coverage today and only
    // run on a real tag push.
    const { raw } = readReleaseWorkflow();
    const pypiJobMatch = raw.match(/publish-pypi:[\s\S]*?(?=\n {2}\S|\n$)/);
    const pypiJob = pypiJobMatch?.[0] ?? "";

    const guardMatch = pypiJob.match(/GITHUB_REF"\s*=~\s*(\S+)\s*\]\]/);
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
    const { raw } = readReleaseWorkflow();
    const npmJobMatch = raw.match(/publish-npm:[\s\S]*?(?=\n {2}\S|\n$)/);
    const npmJob = npmJobMatch?.[0] ?? "";

    const guardMatch = npmJob.match(/GITHUB_REF"\s*=~\s*(\S+)\s*\]\]/);
    expect(guardMatch).not.toBeNull();
    const extractedSource = guardMatch?.[1] ?? "";

    const extractedRegex = new RegExp(extractedSource);
    expect(extractedRegex.test("refs/tags/0.1.0")).toBe(true);
    expect(extractedRegex.test("refs/tags/v0.1.0")).toBe(false);
    expect(extractedRegex.test("refs/tags/0.1")).toBe(false);
    expect(extractedRegex.test("refs/tags/junk")).toBe(false);
  });

  test("create-release's tag-detection grep matches bare semver tags, not v-prefixed", () => {
    const { raw } = readReleaseWorkflow();
    // POSITIVE — the bare grep pattern must be the one wired in.
    expect(raw).toContain("grep -E '^[0-9]+\\.[0-9]+\\.[0-9]+$'");
    // NEGATIVE — the superseded v-prefixed grep pattern must be gone.
    expect(raw).not.toContain("^v[0-9]+\\.[0-9]+\\.[0-9]+$");
  });

  // 🚨 CR-CRU-061 §S2 SUPERSEDES the assertion below (2026-08-04). Cycle 185
  // (§S1/§S6, this same describe block) pinned "publish-npm still VERIFIES
  // package.json against the tag, only the dead #v strip is removed" —
  // correct for that cycle, since §S2 (deriving the version) was explicitly
  // deferred. §S2 now lands: the verify-and-fail comparison is REPLACED by a
  // derive step (`npm version --no-git-tag-version --allow-same-version
  // "$VERSION"`, per the CR's own §S2 text) — package.json is now SET from
  // the tag, not compared against it. The original verify-only assertion
  // remains visible in git history (this file's blame) rather than being
  // restated as live test code — direction reversed, not deleted, per the
  // CR's own §S6 discipline for this file. See also the data-driven
  // execution tests below ("§S2 publish-npm derives...") for the behavioural
  // half of this contract.
  test("publish-npm SETS (derives) package.json's version from the tag; the verify-and-fail comparison is gone, with no dead #v strip", () => {
    const { raw } = readReleaseWorkflow();
    const npmJobMatch = raw.match(/publish-npm:[\s\S]*?(?=\n {2}\S|\n$)/);
    const npmJob = npmJobMatch?.[0] ?? "";

    const runBody = extractNpmVersionRunBody(npmJob);
    // POSITIVE — the derive step exists and matches the CR's own §S2
    // contract text verbatim (not merely "some npm version call").
    expect(runBody.length).toBeGreaterThan(0);
    expect(runBody).toContain("npm version");
    expect(runBody).toContain("--no-git-tag-version");
    expect(runBody).toContain("--allow-same-version");

    // NEGATIVE — the old verify-and-fail comparison is gone, not merely
    // renamed around; and the dead #v strip (already swept in §S1) has not
    // resurfaced.
    expect(npmJob).not.toMatch(/if\s*\[\s*"\$VERSION"\s*!=\s*"\$PKG_VERSION"\s*\]/);
    expect(npmJob.toLowerCase()).not.toContain("!= release tag");
    expect(npmJob).not.toContain('VERSION="${GITHUB_REF_NAME#v}"');
    expect(npmJob).not.toMatch(/#v\}/);
  });

  test("sweep: no #v strip or ^v tag-prefix pattern survives anywhere in release.yml", () => {
    const { raw } = readReleaseWorkflow();
    expect(raw).not.toMatch(/#v\}/);
    expect(raw).not.toContain("^v[0-9]");
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
// The rewritten test in the §S1 describe block above ("publish-npm SETS
// (derives) package.json's version from the tag...") pins the STRUCTURAL
// half of this contract (derive step present, verify-and-fail gone, exact
// flags). The tests below drive the extracted step body as DATA — actually
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
 * Strips the minimum common leading whitespace from every non-blank line, so
 * a YAML block-scalar body can be executed as a standalone shell script
 * regardless of its indentation depth in release.yml.
 */
function dedent(text: string): string {
  const lines = text.split("\n");
  const indents = lines
    .filter((l) => l.trim().length > 0)
    .map((l) => l.match(/^ */)?.[0].length ?? 0);
  const min = indents.length > 0 ? Math.min(...indents) : 0;
  return lines
    .map((l) => l.slice(min))
    .join("\n")
    .trimEnd();
}

/**
 * Extracts the dedented shell body of publish-npm's version-derive step (the
 * step whose run: block invokes `npm version`) from the job's raw YAML text.
 * Returns "" if no such step exists yet (the pre-§S2 state on this branch).
 */
function extractNpmVersionRunBody(npmJob: string): string {
  const stepChunks = npmJob.split(/\n(?=      - )/);
  const stepChunk = stepChunks.find((c) => /npm version/.test(c));
  if (!stepChunk) return "";
  const runMatch = stepChunk.match(/run:\s*\|\n([\s\S]*)/);
  if (!runMatch) return "";
  return dedent(runMatch[1]);
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
    const { raw } = readReleaseWorkflow();
    const npmJobMatch = raw.match(/publish-npm:[\s\S]*?(?=\n {2}\S|\n$)/);
    const npmJob = npmJobMatch?.[0] ?? "";
    return extractNpmVersionRunBody(npmJob);
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

// ---------------------------------------------------------------------------
// CR-CRU-041 §S4 — RELEASING.md
//
// Spec: docs/changes/CR-CRU-041-release-mechanism.md §S4 + Acceptance
// criteria: "RELEASING.md exists and names every prerequisite in §S4,
// including the one-time `git config gitflow.prefix.versiontag v`."
//
// Extends this file rather than starting a new one — it is the established
// home for CR-CRU-041's doc-contract assertions (see the §S1/§S2/§S5
// describes above), following the same pattern §S5 docs — RUNBOOK already
// set for CR-CRU-009: assert on real identifiers/command names pulled from
// the actual production files (scripts/release.sh, release.yml,
// pyproject.toml), not on prose wording, so a RELEASING.md that merely
// "sounds right" but omits a load-bearing name still fails.
//
// RED phase: RELEASING.md does not exist at the repo root on this branch —
// every assertion below is expected to FAIL (file-not-found) against that
// state.
// ---------------------------------------------------------------------------

describe("§S4 docs — RELEASING.md", () => {
  const relPath = "RELEASING.md";

  test("RELEASING.md exists at the repo root", () => {
    expect(existsSync(join(REPO_ROOT, relPath))).toBe(true);
  });

  // CR-CRU-061 §S1/§S4 — re-aimed from CR-CRU-041 §S5's v-prefixed contract.
  // The doc contract is now BARE SemVer, and the old shape is permitted only
  // inside the labelled supersession section, never as live instruction.
  test("documents the tag-driven version model: BARE SemVer tag (no `v`), hatch-vcs derives it, Python version never hand-edited", () => {
    const doc = readText(relPath);
    const lower = doc.toLowerCase();

    // The tag shape itself (bare X.Y.Z) and hatch-vcs as the derivation
    // mechanism. The absence of a prefix is stated, not merely implied.
    expect(doc).toMatch(/\bX\.Y\.Z\b/);
    expect(lower).toMatch(/bare[- ]semver/);
    expect(lower).toMatch(/no `?v`? prefix|without a `?v`? prefix|no prefix of any kind/);
    // The exact guard expression from release.yml — the doc must state the
    // format the publish jobs actually enforce, not a paraphrase.
    expect(doc).toContain("^refs/tags/[0-9]+\\.[0-9]+\\.[0-9]+$");
    expect(lower).toContain("hatch-vcs");
    // The Python version is DERIVED, never hand-edited — pyproject.toml is
    // dynamic (real identifier from the actual pyproject.toml).
    expect(lower).toContain("dynamic");
    expect(lower).toMatch(/never (?:be )?(?:hand|manually)[- ]edit/);

    // CR-CRU-041 §S5's v-prefixed scheme is preserved as HISTORY, in a
    // labelled supersession section — every surviving vX.Y.Z / v0.1.0 mention
    // must sit after that heading, so none of them reads as a live
    // instruction.
    const supersededIdx = doc.indexOf("## Superseded");
    expect(supersededIdx).toBeGreaterThan(-1);
    expect(doc.slice(supersededIdx)).toContain("CR-CRU-041");
    for (const m of doc.matchAll(/v\d+\.\d+\.\d+|v[Xx]\.[Yy]\.[Zz]/g)) {
      expect(m.index).toBeGreaterThan(supersededIdx);
    }
  });

  test("documents the one-time prerequisites: PyPI + TestPyPI pending Trusted Publishers, the pypi/testpypi/npm Environments, and a required reviewer on pypi", () => {
    const doc = readText(relPath);
    const lower = doc.toLowerCase();

    expect(lower).toContain("trusted publisher");
    expect(lower).toContain("testpypi");

    // The three real GitHub Environment names, and the required-reviewer
    // human gate specifically on `pypi`.
    expect(doc).toContain("pypi");
    expect(doc).toContain("npm");
    expect(lower).toMatch(/environment/);
    expect(lower).toMatch(/required reviewer/);
  });

  test("documents RELEASE_PAT and why it is needed (default GITHUB_TOKEN does not re-fire on: release)", () => {
    const doc = readText(relPath);
    const lower = doc.toLowerCase();

    // Exact secret name, matching release.yml:57's actual usage.
    expect(doc).toContain("RELEASE_PAT");
    expect(lower).toContain("github_token");
    // The specific reason: default token release does not re-trigger the
    // release-published workflow.
    expect(lower).toMatch(/re-?fire|re-?trigger/);
    expect(lower).toContain("on: release");
  });

  test("documents NPM_TOKEN for the inaugural scoped publish (no pending-publisher equivalent), then the flip to OIDC", () => {
    const doc = readText(relPath);
    const lower = doc.toLowerCase();

    // Exact secret name, matching release.yml:170's actual usage.
    expect(doc).toContain("NPM_TOKEN");
    expect(lower).toContain("oidc");
    // npm has no pending-publisher equivalent to PyPI's — named explicitly,
    // not merely implied.
    expect(lower).toMatch(/no pending[- ]publisher|does not have.*pending[- ]publisher/);
  });

  // CR-CRU-061 §S1/§S4 — re-aimed: the required state is SET-AND-EMPTY, and
  // UNSET is a distinct, refused state (git-flow itself dies on it).
  test('documents the one-time git config gitflow.prefix.versiontag "" fix (set-and-empty; unset refused), and that it lives in .git/config (not version-controlled)', () => {
    const doc = readText(relPath);
    const lower = doc.toLowerCase();

    // Exact command, matching scripts/release.sh's guard error-message fix.
    expect(doc).toContain('git config gitflow.prefix.versiontag ""');
    expect(doc).toContain(".git/config");
    expect(lower).toMatch(/not version-controlled|not (?:be )?committed|not tracked/);

    // Unset must be documented as WRONG, with git-flow's own measured failure
    // named — otherwise a reader "fixes" it by deleting the key.
    expect(lower).toContain("unset");
    expect(lower).toContain("fatal: version tag not set");

    // The old `v` value may survive only as labelled history.
    const supersededIdx = doc.indexOf("## Superseded");
    const legacyIdx = doc.indexOf("git config gitflow.prefix.versiontag v");
    expect(legacyIdx === -1 || legacyIdx > supersededIdx).toBe(true);
  });

  test("documents the TestPyPI rehearsal loop via scripts/release.sh checkpoint, and that an untagged checkpoint derives a clean X.Y.Z.devN via no-local-version", () => {
    const doc = readText(relPath);
    const lower = doc.toLowerCase();

    expect(doc).toContain("checkpoint");
    expect(doc).toContain("release.sh");
    // Exact hatch-vcs config identifier, matching pyproject.toml:33.
    expect(doc).toContain("no-local-version");
    // The devN suffix shape produced by an untagged checkpoint upload.
    expect(doc).toMatch(/\.dev[Nn]?\b|devN/);
  });

  test("documents the release order: set-version -> finish -> push master -> CI publish chain", () => {
    const doc = readText(relPath);

    // Exact subcommand names, matching scripts/release.sh's actual verbs.
    const setVersionIdx = doc.indexOf("set-version");
    const finishIdx = doc.indexOf("finish");
    const masterIdx = doc.toLowerCase().indexOf("master");

    expect(setVersionIdx).toBeGreaterThan(-1);
    expect(finishIdx).toBeGreaterThan(-1);
    expect(masterIdx).toBeGreaterThan(-1);

    // The order matters: set-version precedes finish precedes the master
    // push in the documented sequence.
    expect(setVersionIdx).toBeLessThan(finishIdx);
    expect(finishIdx).toBeLessThan(masterIdx);
  });

  // CR-CRU-061 §S2/§S4 — re-aimed: the npm side is no longer a manual
  // manifest. BOTH artifacts derive from the one tag, so the doc must name the
  // single authority and the mechanism that enforces it.
  test("documents the composite/lockstep model: one tag publishes both crucible-axi (PyPI, hatch-vcs-derived) and @anthill-tec/crucible-server (npm, tag-derived at publish time) at the same version", () => {
    const doc = readText(relPath);
    const lower = doc.toLowerCase();

    expect(doc).toContain("crucible-axi");
    // Exact scoped npm package name, matching package.json's real "name".
    expect(doc).toContain("@anthill-tec/crucible-server");
    expect(lower).toMatch(/lockstep|composite/);
    expect(lower).toMatch(/derived/);
    // The npm version's real derivation mechanism, verbatim from release.yml's
    // "Set package.json version from the release tag" step — not a paraphrase.
    expect(lower).toContain("npm version --no-git-tag-version --allow-same-version");
    // And the consequence stated plainly: one authority, nothing hand-versioned.
    expect(lower).toMatch(/single version authority|neither is hand-versioned/);
  });
});

// CR-CRU-062 §S0-§S4 — CI actually runs the gates (bun/python/e2e test jobs,
// no event-restricting `if`, and the publish jobs `needs:` them)
//
// Spec: docs/changes/CR-CRU-062-ci-runs-the-gates.md.
//
// §S0 is the load-bearing constraint measured at gap analysis: publish-pypi
// and publish-npm are `if: github.event_name == 'release'`; create-release is
// a DIFFERENT workflow run, gated on push+master. `needs:` only orders jobs
// WITHIN a single run, so a test job scoped to push/pull_request simply does
// not exist in the release run — a publish job that `needs:` a SKIPPED job is
// itself skipped, silently publishing nothing. Therefore the bun/python/e2e
// test jobs below must carry NO event-restricting `if` at all, and the two
// publish jobs must `needs:` them (extending the existing graph — §S4 — not a
// second, parallel guard mechanism).
//
// Extends this file rather than starting a new one, following the pattern the
// §S4 docs — RELEASING.md block above already set: this is the established
// home for release.yml's assertions across every CR that touches it.
//
// Genuinely parses the workflow via Bun.YAML.parse (as the existing
// readReleaseWorkflow()/ReleaseWorkflow helpers above already do) rather than
// substring-matching, for the needs graph and if-absence checks specifically
// — a substring test would pass on a commented-out line or a job name
// appearing only in prose, and the CR spec calls this out explicitly.
//
// RED phase: release.yml on this branch has no bun/python/e2e test job at
// all (this CR's own Context section measured, by sweep, that CI runs no
// test today) — every assertion below is expected to FAIL: the `findJobsRunning`
// lookups return zero matches, so the `.toBe(1)` / `toBeDefined()` guards fail
// first, before the `if`/`needs`/env assertions further down would even be
// reached against a real job.

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

function findJobsRunning062(
  jobs: Record<string, WorkflowJob062>,
  substr: string,
): Array<[string, WorkflowJob062]> {
  return Object.entries(jobs).filter(([, job]) =>
    (job.steps ?? []).some((s) => typeof s.run === "string" && s.run.includes(substr)),
  );
}

function normalizeNeeds062(needs?: string | string[]): string[] {
  if (!needs) return [];
  return Array.isArray(needs) ? needs : [needs];
}

// Exact commands, verbatim from the CR's own §S1/§S2/§S3 text and measured
// against the real repo (package.json's "test"/"test:e2e" scripts, and the
// gap-analysis-measured `python3 -m unittest discover -s tests/client -t .`
// invocation — 683/683 with no server).
const BUN_SUITE_CMD = "bun test";
const PY_SUITE_CMD = "python3 -m unittest discover -s tests/client -t .";
const E2E_SUITE_CMD = "bun run test:e2e";

describe("§S1/§S2/§S3 release.yml declares bun/python/e2e test jobs", () => {
  test("exactly one job runs the bun suite (`bun test`)", () => {
    const jobs = parseReleaseWorkflowJobs062();
    const matches = findJobsRunning062(jobs, BUN_SUITE_CMD);
    // POSITIVE — exactly one, not merely "at least one".
    expect(matches.length).toBe(1);
  });

  test("exactly one job runs the Python suite (`python3 -m unittest discover -s tests/client -t .`)", () => {
    const jobs = parseReleaseWorkflowJobs062();
    const matches = findJobsRunning062(jobs, PY_SUITE_CMD);
    expect(matches.length).toBe(1);
  });

  test("exactly one job runs e2e (`bun run test:e2e`)", () => {
    const jobs = parseReleaseWorkflowJobs062();
    const matches = findJobsRunning062(jobs, E2E_SUITE_CMD);
    expect(matches.length).toBe(1);
  });
});

describe("§S0 the three test jobs carry NO event-restricting `if`", () => {
  test("the bun/python/e2e test jobs each have `if` undefined — they run on push, pull_request, AND release", () => {
    const jobs = parseReleaseWorkflowJobs062();
    const bunJob = findJobsRunning062(jobs, BUN_SUITE_CMD)[0];
    const pyJob = findJobsRunning062(jobs, PY_SUITE_CMD)[0];
    const e2eJob = findJobsRunning062(jobs, E2E_SUITE_CMD)[0];

    // Guard: the jobs must actually exist before their `if` can be judged
    // absent — otherwise `undefined` would vacuously "pass" against a job
    // that was never found.
    expect(bunJob).toBeDefined();
    expect(pyJob).toBeDefined();
    expect(e2eJob).toBeDefined();

    // POSITIVE — the required property is the ABSENCE of `if`, so the run
    // event alone (push/pull_request/release) governs whether the job runs.
    expect(bunJob?.[1].if).toBeUndefined();
    expect(pyJob?.[1].if).toBeUndefined();
    expect(e2eJob?.[1].if).toBeUndefined();
  });
});

describe("§S4 publish-pypi and publish-npm `needs:` all three test jobs", () => {
  test("publish-pypi needs build + the bun/python/e2e test jobs", () => {
    const jobs = parseReleaseWorkflowJobs062();
    const bunJobName = findJobsRunning062(jobs, BUN_SUITE_CMD)[0]?.[0];
    const pyJobName = findJobsRunning062(jobs, PY_SUITE_CMD)[0]?.[0];
    const e2eJobName = findJobsRunning062(jobs, E2E_SUITE_CMD)[0]?.[0];

    expect(bunJobName).toBeDefined();
    expect(pyJobName).toBeDefined();
    expect(e2eJobName).toBeDefined();

    const publishPypi = jobs["publish-pypi"];
    expect(publishPypi).toBeDefined();
    const needs = normalizeNeeds062(publishPypi?.needs);

    // POSITIVE — build must survive (§S4: extend the graph, not replace it),
    // plus all three test jobs.
    expect(needs).toContain("build");
    expect(needs).toContain(bunJobName as string);
    expect(needs).toContain(pyJobName as string);
    expect(needs).toContain(e2eJobName as string);
  });

  test("publish-npm needs build + the bun/python/e2e test jobs", () => {
    const jobs = parseReleaseWorkflowJobs062();
    const bunJobName = findJobsRunning062(jobs, BUN_SUITE_CMD)[0]?.[0];
    const pyJobName = findJobsRunning062(jobs, PY_SUITE_CMD)[0]?.[0];
    const e2eJobName = findJobsRunning062(jobs, E2E_SUITE_CMD)[0]?.[0];

    expect(bunJobName).toBeDefined();
    expect(pyJobName).toBeDefined();
    expect(e2eJobName).toBeDefined();

    const publishNpm = jobs["publish-npm"];
    expect(publishNpm).toBeDefined();
    const needs = normalizeNeeds062(publishNpm?.needs);

    expect(needs).toContain("build");
    expect(needs).toContain(bunJobName as string);
    expect(needs).toContain(pyJobName as string);
    expect(needs).toContain(e2eJobName as string);
  });
});

describe("§S2 the Python test job is server-free", () => {
  test("uses `unittest discover` and does NOT use the client's `regression` verb or CRUCIBLE_PROJECT_KEY", () => {
    const jobs = parseReleaseWorkflowJobs062();
    const matches = findJobsRunning062(jobs, PY_SUITE_CMD);
    expect(matches.length).toBe(1);
    const [, job] = matches[0];

    const runText = (job.steps ?? []).map((s) => s.run ?? "").join("\n");
    // NEGATIVE — the server-needing verb and its required env var must be
    // absent from the WHOLE job (every step), not merely from the one step
    // that happens to match PY_SUITE_CMD.
    expect(runText).not.toContain("regression");
    expect(runText.toLowerCase()).not.toContain("crucible_project_key");
    const jobEnvText = JSON.stringify(job.env ?? {}) + (job.steps ?? []).map((s) => JSON.stringify(s.env ?? {})).join("");
    expect(jobEnvText.toLowerCase()).not.toContain("crucible_project_key");
  });
});

describe("§S3 the e2e job sets CRUCIBLE_DB explicitly in its env", () => {
  test("CRUCIBLE_DB is present with a non-empty value, declared on the job (not inherited from the ambient environment)", () => {
    const jobs = parseReleaseWorkflowJobs062();
    const matches = findJobsRunning062(jobs, E2E_SUITE_CMD);
    expect(matches.length).toBe(1);
    const [, job] = matches[0];

    // CRUCIBLE_DB may be declared at job level or on the specific run step —
    // either satisfies "the job sets it explicitly"; what must NOT happen is
    // it being absent from both (silently inherited/ambient, CR-052's exact
    // failure mode).
    const jobEnvValue = job.env?.CRUCIBLE_DB;
    const stepEnvValue = (job.steps ?? [])
      .map((s) => s.env?.CRUCIBLE_DB)
      .find((v) => typeof v === "string");
    const value = jobEnvValue ?? stepEnvValue;

    expect(value).toBeDefined();
    expect(typeof value).toBe("string");
    expect((value as string).length).toBeGreaterThan(0);
  });
});

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
  test("at least one job dry-run-packs the npm server artifact with NO event-restricting `if` (runs on push, not just workflow_dispatch rehearsal)", () => {
    // BORN RED — today exactly one job (`dry-run-npm`) matches the
    // pack/dry-run pattern, and its `if` is
    // `github.event_name == 'workflow_dispatch'` — defined, not absent — so
    // the "unconditional" filter below currently yields zero matches.
    const jobs = parseReleaseWorkflowJobs062();
    const matches = findJobsMatchingRun062(jobs, NPM_PACK_DRYRUN_PATTERN);
    const unconditional = matches.filter(([, job]) => job.if === undefined);

    // POSITIVE — at least one such job exists AND runs unconditionally.
    expect(unconditional.length).toBeGreaterThanOrEqual(1);
  });

  test("the unconditional packaging step, executed for real, resolves the declared bin entrypoint (bin/crucible-server.mjs) into the tarball", () => {
    // Guard first (assertion, not a crash): the previous test's own
    // condition must hold before this one can extract a real script to run.
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
    const proc = Bun.spawnSync(["bash", "-c", script], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
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

// ---------------------------------------------------------------------------
// CR-CRU-066 §S4 / AC6 — Docs reconciled to the shipped install/serve contract
// (RED).
//
// Spec: docs/changes/CR-CRU-066-install-provisions-not-runs-plus-serve.md §S4
// + AC6.
//
// Extends THIS file rather than starting a second doc-as-data mechanism: the
// "§S5 docs — README quick start" / "§S5 docs — RUNBOOK" / "§S1 install.sh
// bootstrap" describes above are the established home for README, RUNBOOK and
// install.sh contracts, and every later CR that touched a doc (CR-041 §S4
// RELEASING.md, CR-062 release.yml) extended here for the same reason. The
// assertions below therefore ADD to those, and deliberately do not weaken
// any of them (the pre-existing curl|sh regex, CRUCIBLE_PORT/CRUCIBLE_HOST,
// corrupt-db, retention and uv-flow assertions must all stay green).
//
// What shipped in C1-C3 and what the docs still claim:
//   * `crucible-axi install` PROVISIONS and EXITS — it guarantees Bun,
//     provisions the server user-scoped, creates its target dir and writes
//     the manifest. STAGE_ORDER = ("server", "manifest"); there is NO skills
//     stage (CR-042 retired it — skills are Model-B's `modelb-axi`).
//   * `crucible-axi serve` RUNS the server in the foreground.
//   * `[project.scripts]` declares ONLY `crucible-axi`, so a bare
//     `crucible-server` command is not installed by anything.
//
// The six measured doc defects each get an assertion below:
//   1. README:21 `curl -fsSL https://crucible.dev/install.sh | sh` —
//      `crucible.dev` is NOT REGISTERED (does not resolve). The repo is
//      public, so GitHub raw serves the same install.sh.
//   2. README:33 "installs the multi-harness skill set" — false since CR-042.
//   3. README:40 documents a bare `crucible-server` command — not installed.
//   4. README:58 describes `clients/skills/` as a shipped deliverable —
//      the directory does not even exist any more (CR-042).
//   5. docs/RUNBOOK.md:9/:126/:130 invoke a bare `crucible-server`.
//   6. install.sh's header still calls its own hosting URL a human-gated
//      unfinished step and still claims a skill-set install.
//
// 🚨 DELIBERATE DEVIATION FROM THE SPEC TEXT, recorded not silently taken:
// §S4 writes the one-liner as
// `raw.githubusercontent.com/anthill-tec/crucible/<tag>/install.sh`. This
// suite pins the `master` REF instead of a version tag. Reason: this is a
// git-flow repo where `master` only ever advances at a release, so the
// `master` ref always serves the latest RELEASED installer and never needs a
// per-release bump, whereas a `<tag>` pin goes stale the moment the next
// release lands (and a stale quick-start one-liner is precisely the class of
// defect this CR exists to kill). Pinned as an ANTI-assertion too: a
// version-shaped ref is rejected outright, so nobody can "fix" this back into
// a per-release maintenance burden without changing this test.
// ---------------------------------------------------------------------------

/** The canonical, always-latest-release quick-start installer URL. */
const INSTALL_SH_RAW_URL =
  "https://raw.githubusercontent.com/anthill-tec/crucible/master/install.sh";

/**
 * Returns the bodies of every fenced code block in `markdown`, optionally
 * restricted to blocks whose info string matches `lang`.
 */
function fencedCodeBlocks(markdown: string, lang?: string): string[] {
  const blocks: string[] = [];
  const fence = /^```([^\n`]*)\n([\s\S]*?)^```/gm;
  for (const match of markdown.matchAll(fence)) {
    const info = match[1].trim();
    if (lang === undefined || info === lang) blocks.push(match[2]);
  }
  return blocks;
}

/**
 * Returns the body of the markdown section introduced by `heading` (up to the
 * next heading of the same or a shallower level). Fence-aware: a shell comment
 * inside a fenced code block (`# via the launcher`) is NOT a heading, so a
 * section whose examples carry comments is not truncated at the first one.
 */
function markdownSection(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const startIdx = lines.findIndex((line) => line.trim() === heading);
  if (startIdx === -1) return "";
  const depth = heading.match(/^#+/)?.[0].length ?? 1;
  const body: string[] = [];
  let inFence = false;
  for (const line of lines.slice(startIdx + 1)) {
    if (line.startsWith("```")) inFence = !inFence;
    if (!inFence && !line.startsWith("```")) {
      const hashes = line.match(/^(#+)\s/);
      if (hashes !== null && hashes[1].length <= depth) break;
    }
    body.push(line);
  }
  return body.join("\n");
}

/**
 * Every executable-looking line inside `markdown`'s fenced code blocks, with
 * comment-only lines and blanks dropped. This is what makes the "no bare
 * `crucible-server` COMMAND" assertions target command-line USAGE rather than
 * any occurrence of the string: a path (`bin/crucible-server.mjs`) or an npm
 * package name mentioned in prose is untouched by these.
 */
function shellCommandLines(markdown: string): string[] {
  return fencedCodeBlocks(markdown)
    .flatMap((block) => block.split("\n"))
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * A command line whose invoked program is a bare `crucible-server` — i.e. the
 * command that NOTHING installs (`[project.scripts]` declares only
 * `crucible-axi`). Leading `VAR=value` environment prefixes are skipped so
 * `CRUCIBLE_PORT=4000 crucible-server` is caught too; a path-qualified
 * `~/.bun/bin/crucible-server` is NOT matched (that one really exists).
 */
const BARE_CRUCIBLE_SERVER_COMMAND = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*crucible-server\b/;

function bareCrucibleServerCommands(markdown: string): string[] {
  return shellCommandLines(markdown).filter((line) =>
    BARE_CRUCIBLE_SERVER_COMMAND.test(line),
  );
}

describe("CR-CRU-066 §S4/AC6 docs — README quick start reconciled", () => {
  // Defect 1 — `crucible.dev` is not a registered domain.
  test("README names no `crucible.dev` host anywhere (unregistered domain)", () => {
    expect(readText("README.md")).not.toContain("crucible.dev");
  });

  // Defect 1 — the replacement one-liner, inside the quick-start block.
  test("the quick-start one-liner curls install.sh from GitHub raw at the `master` ref", () => {
    const quickStart = markdownSection(readText("README.md"), "## Quick start");
    expect(quickStart).not.toBe("");

    const blocks = fencedCodeBlocks(quickStart, "sh");
    expect(blocks.length).toBeGreaterThan(0);

    // The one-liner lives INSIDE a quick-start code block, not merely
    // somewhere in the prose.
    const oneLiners = blocks.filter((block) => /curl\s+-fsSL\s+\S*install\.sh\s*\|\s*sh/.test(block));
    expect(oneLiners.length).toBeGreaterThan(0);

    const oneLiner = oneLiners.join("\n");
    expect(oneLiner).toContain(INSTALL_SH_RAW_URL);
    // URL SHAPE, asserted independently of the literal above: raw host, the
    // real owner/repo, the `master` ref, `install.sh`.
    expect(oneLiner).toMatch(
      /curl\s+-fsSL\s+https:\/\/raw\.githubusercontent\.com\/anthill-tec\/crucible\/master\/install\.sh\s*\|\s*sh/,
    );
    // ANTI-assertion (see the 🚨 note above): never a version-shaped ref, which
    // would go stale every release.
    expect(oneLiner).not.toMatch(
      /raw\.githubusercontent\.com\/anthill-tec\/crucible\/v?\d+\.\d+\.\d+\//,
    );
  });

  // Defect 3 — the bare `crucible-server` command is not installed by anything.
  test("README documents NO bare `crucible-server` command line", () => {
    expect(bareCrucibleServerCommands(readText("README.md"))).toEqual([]);
  });

  // Defect 3 — and documents the verb that actually runs the server.
  test("README documents `crucible-axi serve` as the run command", () => {
    const readme = readText("README.md");
    expect(readme).toContain("crucible-axi serve");
    // In a runnable code block, not only in prose.
    expect(shellCommandLines(readme).some((line) => line.startsWith("crucible-axi serve"))).toBe(
      true,
    );
  });

  // Defects 2 + 4 — CR-042 retired the `[skills]` stage; the repo ships none
  // (`clients/skills/` no longer even exists) and install installs none.
  test("README makes no skills claim at all (CR-042 retired the skills stage)", () => {
    const readme = readText("README.md");
    expect(readme).not.toMatch(/skill/i);
    expect(readme).not.toContain("clients/skills");
  });

  // Defect 2 — what install ACTUALLY does: the two real stages.
  test("README describes `crucible-axi install` as provisioning the server + writing the manifest", () => {
    const readme = readText("README.md");
    expect(readme).toContain("manifest");

    // The paragraph that introduces `crucible-axi install` must name BOTH
    // real stages — a "manifest" mentioned only in some unrelated section
    // would not reconcile the install description itself.
    const paragraph = readme
      .split(/\n\s*\n/)
      .find((para) => /`?crucible-axi install`?/.test(para) && !para.trimStart().startsWith("```"));
    expect(paragraph).toBeDefined();
    expect(paragraph!).toMatch(/server/i);
    expect(paragraph!).toMatch(/manifest/i);
  });
});

describe("CR-CRU-066 §S4/AC6 docs — RUNBOOK reconciled", () => {
  // Defect 5 — RUNBOOK:9/:126/:130.
  test("docs/RUNBOOK.md documents NO bare `crucible-server` command line", () => {
    expect(bareCrucibleServerCommands(readText(join("docs", "RUNBOOK.md")))).toEqual([]);
  });

  test("docs/RUNBOOK.md starts the server with `crucible-axi serve`", () => {
    const runbook = readText(join("docs", "RUNBOOK.md"));
    const start = markdownSection(runbook, "## Start");
    expect(start).not.toBe("");
    expect(shellCommandLines(start).some((line) => line.startsWith("crucible-axi serve"))).toBe(
      true,
    );
  });

  // §S4: keep the env-var examples — reconciled onto the real command, NOT
  // deleted. Guards against a GREEN that fixes the command by dropping the
  // documentation the pre-existing §S5 RUNBOOK test relies on.
  test("docs/RUNBOOK.md keeps its CRUCIBLE_PORT / CRUCIBLE_HOST examples, on `crucible-axi serve`", () => {
    const commands = shellCommandLines(readText(join("docs", "RUNBOOK.md")));
    expect(commands.some((line) => /^CRUCIBLE_PORT=\S+\s+crucible-axi serve\b/.test(line))).toBe(
      true,
    );
    expect(commands.some((line) => /^CRUCIBLE_HOST=\S+.*\bcrucible-axi serve\b/.test(line))).toBe(
      true,
    );
  });

  // §S4: "note Bun is the runtime and is guaranteed by `crucible-axi install`".
  test("docs/RUNBOOK.md names Bun as the runtime, guaranteed by `crucible-axi install`", () => {
    const runbook = readText(join("docs", "RUNBOOK.md"));
    expect(runbook).toMatch(/\bBun\b/);
    expect(runbook).toContain("crucible-axi install");
    // Out-of-scope §: "No `npx`/node path — the server is a Bun program".
    expect(runbook).not.toMatch(/npx/i);
  });
});

describe("CR-CRU-066 §S4/AC6 docs — install.sh header prose reconciled", () => {
  // Defect 6 — install.sh:4/:16/:18-20 still call the hosting URL an
  // unfinished human-gated step and leave `<crucible>` as a placeholder.
  test("install.sh no longer presents its hosting URL as an unfinished, human-gated step", () => {
    const script = readText("install.sh");
    expect(script).not.toMatch(/human-gated/i);
    expect(script).not.toContain("<crucible>");
    // It states the REAL hosting URL instead (the repo is public).
    expect(script).toContain(INSTALL_SH_RAW_URL);
  });

  // Defect 6 — install.sh:10 still claims a skill-set install.
  test("install.sh claims no skill-set install and names the two real stages", () => {
    const script = readText("install.sh");
    expect(script).not.toMatch(/skill/i);
    expect(script).toMatch(/manifest/i);
    // Bun-only: `npx` is not the server's launcher (Out-of-scope §).
    expect(script).not.toMatch(/npx/i);
  });
});
