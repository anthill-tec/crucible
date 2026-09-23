// CR-CRU-018 §S1 AC13/AC14 — "The phone band runs on BOTH engines" (DN
// decision 13, user ruling 2026-09-23) and "WebKit is provisioned in CI, and
// its local absence is EXPLICIT" (docs/changes/CR-CRU-018-responsive-mobile.md).
//
// Spec: docs/changes/CR-CRU-018-responsive-mobile.md, Acceptance criteria
//   "the `webkit-iphone` project ... testMatch scoped to the SAME phone
//    feature file `chromium-mobile` runs" / "`grepInvert: /@empty-db/` and
//    `dependencies: ["chromium-empty-db"]`" / "the container's `localhost` is
//    not the host's ... handle it in config, not by hand-editing tests"
// Governed by: docs/research/DN-crucible-responsive-model.md, decision 13 and
//   "WebKit provisioning — the two paths".
//
// A RAIL, BORN GREEN — playwright.config.ts's `webkit-iphone` project is
// implemented in THIS SAME RED pass (item 1/2 of this cycle's dispatch), so
// these assertions pass today. They exist so a LATER edit cannot silently
// delete or degrade the project: every assertion below is proved to FAIL
// first (see the header note on each describe block for exactly which
// property was missing/wrong before playwright.config.ts's `webkit-iphone`
// project existed — measured by removing the project and re-running this
// file, per this cycle's own RED-quality checklist), which is what makes it a
// real rail rather than a test that could never go red.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { devices } from "@playwright/test";
import playwrightConfig from "../playwright.config.ts";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

interface ProjectLike {
  name?: string;
  use?: Record<string, unknown>;
  testMatch?: unknown;
  grepInvert?: RegExp | RegExp[];
  dependencies?: string[];
}

const projects = (playwrightConfig.projects ?? []) as ProjectLike[];
const webkitProject = projects.find((p) => p.name === "webkit-iphone");
const chromiumMobileProject = projects.find((p) => p.name === "chromium-mobile");

describe("CR-CRU-018 §S1 AC13 — the pinned iPhone 15 device profile is REAL webkit, not assumed", () => {
  test('devices["iPhone 15"] exists at this pinned Playwright version (^1.61.1) and declares defaultBrowserType "webkit" — the DN\'s own caution ("do not assume iPhone 15 exists") checked against the real installed descriptor, not memory', () => {
    // node_modules/playwright-core/lib/server/deviceDescriptorsSource.json,
    // read via @playwright/test's own `devices` export — the same source
    // playwright.config.ts spreads from, so this assertion and the config
    // can never silently disagree about which object "iPhone 15" resolves to.
    const iphone15 = devices["iPhone 15"];
    expect(iphone15, 'this pinned Playwright version has no "iPhone 15" device descriptor').toBeDefined();
    expect(iphone15?.defaultBrowserType).toBe("webkit");
    expect(iphone15?.isMobile).toBe(true);
    expect(iphone15?.hasTouch).toBe(true);
  });
});

describe("CR-CRU-018 §S1 AC13/AC14 — playwright.config.ts declares webkit-iphone with the phone feature and the @empty-db guard (RAIL)", () => {
  test("a project named webkit-iphone exists and really launches WebKit (not Chromium under an iPhone UA)", () => {
    expect(webkitProject, "playwright.config.ts declares no 'webkit-iphone' project").toBeDefined();
    expect(webkitProject?.use?.defaultBrowserType).toBe("webkit");
    expect(webkitProject?.use?.isMobile).toBe(true);
    expect(webkitProject?.use?.hasTouch).toBe(true);
    expect(String(webkitProject?.use?.userAgent)).toContain("iPhone");
  });

  test("webkit-iphone's testMatch is the IDENTICAL regex chromium-mobile uses — the SAME phone feature file, never a second one", () => {
    expect(chromiumMobileProject, "playwright.config.ts declares no 'chromium-mobile' project to compare against").toBeDefined();
    const webkitMatch = webkitProject?.testMatch;
    const chromiumMatch = chromiumMobileProject?.testMatch;
    expect(webkitMatch instanceof RegExp, "webkit-iphone's testMatch is not a single RegExp").toBe(true);
    expect(chromiumMatch instanceof RegExp, "chromium-mobile's testMatch is not a single RegExp").toBe(true);
    expect((webkitMatch as RegExp).source).toBe((chromiumMatch as RegExp).source);
    expect((webkitMatch as RegExp).source).toBe("mobile-viewport-responsive\\.feature\\.spec\\.js$");
  });

  test("webkit-iphone carries grepInvert: /@empty-db/ and dependencies: [\"chromium-empty-db\"] — never a second ordering-precondition dependency", () => {
    const invert = webkitProject?.grepInvert;
    expect(invert instanceof RegExp, "webkit-iphone's grepInvert is not a single RegExp").toBe(true);
    expect((invert as RegExp).source).toBe("@empty-db");
    expect(webkitProject?.dependencies).toEqual(["chromium-empty-db"]);
  });
});

describe("CR-CRU-018 — the container's localhost is not the host's: answered by Playwright's exposeNetwork tether, so no project's baseURL ever leaves localhost", () => {
  // Config side effects (mkdtempSync/writeFileSync, defineBddConfig) run once
  // at IMPORT time, so re-importing the SAME process with a different
  // PW_TEST_CONNECT_WS_ENDPOINT cannot re-resolve baseURL — each branch is
  // therefore read from a FRESH child process, which is the only way to
  // prove this is a real per-env branch rather than one value memorised at
  // module load.
  async function resolvedBaseUrl(env: Record<string, string>): Promise<string> {
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        "const cfg = (await import('./playwright.config.ts')).default;" +
          "const p = cfg.projects.find((p) => p.name === 'webkit-iphone');" +
          "process.stdout.write(String(p.use.baseURL));",
      ],
      { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code, `resolving webkit-iphone's baseURL exited ${String(code)}: ${stderr}`).toBe(0);
    return stdout.trim();
  }

  test("without PW_TEST_CONNECT_WS_ENDPOINT (CI's native install, or a plain local run), baseURL stays localhost:<E2E_PORT> — the SAME host every other project uses", async () => {
    const url = await resolvedBaseUrl({ PW_TEST_CONNECT_WS_ENDPOINT: "" });
    expect(url).toBe("http://localhost:39877");
  });

  // Every project's EFFECTIVE baseURL (its own `use.baseURL`, else the
  // config-level one it inherits), read from a fresh child process for the
  // same reason as `resolvedBaseUrl` above.
  async function everyProjectBaseUrl(env: Record<string, string>): Promise<Record<string, string>> {
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        "const cfg = (await import('./playwright.config.ts')).default;" +
          "const out = {};" +
          "for (const p of cfg.projects) out[p.name] = String(p.use?.baseURL ?? cfg.use?.baseURL);" +
          "process.stdout.write(JSON.stringify(out));",
      ],
      { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code, `resolving every project's baseURL exited ${String(code)}: ${stderr}`).toBe(0);
    return JSON.parse(stdout) as Record<string, string>;
  }

  test("with PW_TEST_CONNECT_WS_ENDPOINT set (the Docker Playwright Server path), the launcher tethers the container's loopback with PW_TEST_CONNECT_EXPOSE_NETWORK=<loopback>, and NO project's baseURL leaves localhost:<E2E_PORT> — never a container-only alias, never the workstation's :3850 dev board", async () => {
    const launcher = readFileSync(join(REPO_ROOT, "scripts", "webkit-docker-server.ts"), "utf8");
    expect(launcher).toContain("process.env.PW_TEST_CONNECT_EXPOSE_NETWORK = EXPOSE_NETWORK;");
    const runner = readFileSync(join(REPO_ROOT, "scripts", "webkit-docker-runner.ts"), "utf8");
    expect(runner).toContain('export const EXPOSE_NETWORK = "<loopback>";');

    const urls = await everyProjectBaseUrl({
      PW_TEST_CONNECT_WS_ENDPOINT: "ws://127.0.0.1:53333/",
      PW_TEST_CONNECT_EXPOSE_NETWORK: "<loopback>",
    });
    expect(Object.keys(urls)).toContain("webkit-iphone");
    expect(Object.keys(urls)).toContain("chromium-empty-db");
    for (const [name, url] of Object.entries(urls)) {
      expect(url, `project ${name}`).toBe("http://localhost:39877");
    }
  });
});

describe("CR-CRU-018 — playwright.config.ts's own source names the DN's mechanics literally, so a reader lands on the real doc", () => {
  test("the config cites DN-crucible-responsive-model.md's 'WebKit provisioning' section and the PW_TEST_CONNECT_WS_ENDPOINT env var by name", () => {
    const source = readFileSync(join(REPO_ROOT, "playwright.config.ts"), "utf8");
    expect(source).toContain("PW_TEST_CONNECT_WS_ENDPOINT");
    expect(source).toContain("WebKit provisioning");
  });
});
