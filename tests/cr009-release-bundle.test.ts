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

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error("no YAML frontmatter block found (expected leading --- ... ---)");
  }
  return Bun.YAML.parse(match[1]) as Record<string, unknown>;
}

function bodyAfterFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return match ? match[1] : content;
}

// ---------------------------------------------------------------------------
// §S3 — skills Vercel-Skills conformance (name + trigger description +
// metadata: {author, version})
// ---------------------------------------------------------------------------

const REPORT_SKILL_STACKS = ["bun", "java", "python", "rust", "vscode"] as const;

const CONFORM_SKILL_DIRS: ReadonlyArray<string> = [
  "agent-protocol",
  "crucible-register",
  ...REPORT_SKILL_STACKS.map((s) => `crucible-report-${s}`),
];

describe("§S3 skills Vercel-Skills conformance", () => {
  for (const dir of CONFORM_SKILL_DIRS) {
    const relPath = join("clients", "skills", dir, "SKILL.md");

    test(`${dir}/SKILL.md has a name + non-trivial trigger description`, () => {
      const content = readText(relPath);
      const front = parseFrontmatter(content);

      expect(typeof front.name).toBe("string");
      expect((front.name as string).length).toBeGreaterThan(0);

      expect(typeof front.description).toBe("string");
      // A real trigger description reads as a sentence, not a one-word stub.
      expect((front.description as string).length).toBeGreaterThan(20);
    });

    test(`${dir}/SKILL.md carries a metadata: block with author + semver version`, () => {
      const content = readText(relPath);
      const front = parseFrontmatter(content);

      expect(front.metadata).toBeDefined();
      expect(typeof front.metadata).toBe("object");
      const metadata = front.metadata as Record<string, unknown>;

      expect(typeof metadata.author).toBe("string");
      expect((metadata.author as string).length).toBeGreaterThan(0);

      expect(typeof metadata.version).toBe("string");
      expect(metadata.version as string).toMatch(/^\d+\.\d+\.\d+/);
    });
  }
});

// ---------------------------------------------------------------------------
// §S3 reconcile — crucible-report-arduino skill
// ---------------------------------------------------------------------------

describe("§S3 arduino skill reconcile", () => {
  const relPath = join("clients", "skills", "crucible-report-arduino", "SKILL.md");

  test("crucible-report-arduino/SKILL.md exists and conforms (name + description + metadata)", () => {
    expect(existsSync(join(REPO_ROOT, relPath))).toBe(true);

    const content = readText(relPath);
    const front = parseFrontmatter(content);

    expect(front.name).toBe("crucible-report-arduino");
    expect(typeof front.description).toBe("string");
    expect((front.description as string).length).toBeGreaterThan(20);

    expect(typeof front.metadata).toBe("object");
    const metadata = front.metadata as Record<string, unknown>;
    expect(typeof metadata.author).toBe("string");
    expect(metadata.version as string).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("crucible-report-arduino/SKILL.md body references clients/arduino-crucible.py", () => {
    const content = readText(relPath);
    const body = bodyAfterFrontmatter(content);
    expect(body).toContain("clients/arduino-crucible.py");
  });
});

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
