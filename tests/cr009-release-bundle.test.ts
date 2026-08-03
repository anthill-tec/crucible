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
import { existsSync, readFileSync } from "node:fs";
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

  test("publish-npm still verifies the release tag against package.json version, with no dead #v strip", () => {
    const { raw } = readReleaseWorkflow();
    const npmJobMatch = raw.match(/publish-npm:[\s\S]*?(?=\n {2}\S|\n$)/);
    const npmJob = npmJobMatch?.[0] ?? "";

    // POSITIVE — the verify-only comparison step itself is unchanged this
    // cycle (§S2 — deriving npm's version FROM the tag — is a later cycle;
    // §S1 only removes the now-dead v-strip from the comparison).
    expect(npmJob.toLowerCase()).toContain("package.json");
    // NEGATIVE — a bare GITHUB_REF_NAME has no leading 'v' to strip; the
    // strip is dead code under this CR and must not survive.
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

  test("documents the tag-driven version model: v-prefixed tag, hatch-vcs strips the v, Python version never hand-edited", () => {
    const doc = readText(relPath);
    const lower = doc.toLowerCase();

    // The tag shape itself (vX.Y.Z) and hatch-vcs as the derivation mechanism.
    expect(doc).toMatch(/v[Xx]\.[Yy]\.[Zz]|v<?major>?\.<?minor>?\.<?patch>?/);
    expect(lower).toContain("hatch-vcs");
    // The Python version is DERIVED, never hand-edited — pyproject.toml is
    // dynamic (real identifier from the actual pyproject.toml).
    expect(lower).toContain("dynamic");
    expect(lower).toMatch(/never (?:be )?(?:hand|manually)[- ]edit/);
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

  test("documents the one-time git config gitflow.prefix.versiontag v fix, and that it lives in .git/config (not version-controlled)", () => {
    const doc = readText(relPath);
    const lower = doc.toLowerCase();

    // Exact command, matching scripts/release.sh:176's error-message fix.
    expect(doc).toContain("git config gitflow.prefix.versiontag v");
    expect(doc).toContain(".git/config");
    expect(lower).toMatch(/not version-controlled|not (?:be )?committed|not tracked/);
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

  test("documents the composite/lockstep model: one tag publishes both crucible-axi (PyPI, derived) and @anthill-tec/crucible-server (npm, manual manifest) at the same version", () => {
    const doc = readText(relPath);
    const lower = doc.toLowerCase();

    expect(doc).toContain("crucible-axi");
    // Exact scoped npm package name, matching package.json's real "name".
    expect(doc).toContain("@anthill-tec/crucible-server");
    expect(lower).toMatch(/lockstep|composite/);
    // Distinguishes the two version-authority mechanisms by name.
    expect(lower).toMatch(/derived/);
    expect(lower).toMatch(/manual manifest|manually[- ]versioned|hand[- ]versioned/);
  });
});
