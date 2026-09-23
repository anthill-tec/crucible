// CR-CRU-018 §S1 AC13/AC14 — "WebKit is provisioned in CI, and its local
// absence is EXPLICIT" — for THIS cycle's ruling, "absence" is a fail-loud
// ACTIONABLE remedy, never a silent skip and never a confusing
// browser-not-found stack.
//
// Spec: docs/changes/CR-CRU-018-responsive-mobile.md's WebKit ACs, governed by
// docs/research/DN-crucible-responsive-model.md's "WebKit provisioning — the
// two paths" (Docker `run-server`, image pinned EXACTLY to `@playwright/test`,
// `--add-host=hostmachine:host-gateway`).
//
// Pure-logic tests: tests/e2e/steps/webkit-docker-preflight.ts's guard
// function and scripts/webkit-docker-runner.ts's Docker-invocation shape,
// both asserted directly — no Playwright, no browser, no Docker daemon.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  WEBKIT_DOCKER_NPM_SCRIPT,
  webkitLocalGuardMessage,
} from "./e2e/steps/webkit-docker-preflight.ts";
import {
  CONTAINER_NAME,
  HOSTMACHINE_ALIAS,
  RUN_SERVER_PORT,
  dockerImageTag,
  dockerRunArgs,
  exactPlaywrightVersion,
  pinnedPlaywrightRange,
  runServerWsEndpoint,
} from "../scripts/webkit-docker-runner.ts";

const REPO_ROOT = join(import.meta.dir, "..");

describe("CR-CRU-018 — webkitLocalGuardMessage: never a silent skip, never a confusing browser-not-found stack", () => {
  test("refuses a NATIVE webkit launch locally (no CI, no Docker endpoint) with a message naming the exact remedy command", () => {
    const message = webkitLocalGuardMessage({
      browserName: "webkit",
      isCI: false,
      wsEndpoint: undefined,
    });
    expect(message, "expected a defined remedy message — a local webkit launch with no Docker endpoint must never silently proceed").toBeDefined();
    expect(message).toContain(WEBKIT_DOCKER_NPM_SCRIPT);
    expect(message).toContain("Docker");
    // NEGATIVE — never claims WebKit is simply unavailable/skipped; it must
    // read as an actionable remedy, not a shrug.
    expect(message?.toLowerCase()).not.toContain("skip");
  });

  test("refuses when wsEndpoint is set to an empty string — an unset-looking env var is not a real endpoint", () => {
    const message = webkitLocalGuardMessage({ browserName: "webkit", isCI: false, wsEndpoint: "" });
    expect(message).toBeDefined();
    const messageBlank = webkitLocalGuardMessage({ browserName: "webkit", isCI: false, wsEndpoint: "   " });
    expect(messageBlank).toBeDefined();
  });

  test("allows CI's native install — isCI true short-circuits with no message even absent a Docker endpoint", () => {
    const message = webkitLocalGuardMessage({ browserName: "webkit", isCI: true, wsEndpoint: undefined });
    expect(message).toBeUndefined();
  });

  test("allows a run already pointed at the Docker Playwright Server", () => {
    const message = webkitLocalGuardMessage({
      browserName: "webkit",
      isCI: false,
      wsEndpoint: "ws://127.0.0.1:53333/",
    });
    expect(message).toBeUndefined();
  });

  test("is a NO-OP for every non-webkit project (chromium-mobile, chromium-tablet, …) regardless of CI/endpoint state", () => {
    for (const isCI of [true, false]) {
      for (const wsEndpoint of [undefined, "", "ws://127.0.0.1:53333/"]) {
        expect(webkitLocalGuardMessage({ browserName: "chromium", isCI, wsEndpoint })).toBeUndefined();
      }
    }
  });

  test("WEBKIT_DOCKER_NPM_SCRIPT names package.json's REAL script — the two cannot drift apart unnoticed", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(WEBKIT_DOCKER_NPM_SCRIPT).toBe("bun run test:e2e:webkit");
    const scriptName = WEBKIT_DOCKER_NPM_SCRIPT.replace(/^bun run /, "");
    expect(
      pkg.scripts?.[scriptName],
      `package.json declares no "${scriptName}" script, but the guard message tells developers to run it`,
    ).toBeDefined();
  });
});

describe("CR-CRU-018 — the Docker image tag is DERIVED from @playwright/test's pin, never a second literal (DN: a mismatch leaves Playwright unable to locate browser executables)", () => {
  test("mirrors this repository's own pinned @playwright/test range exactly", () => {
    const range = pinnedPlaywrightRange(REPO_ROOT);
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    const declared = pkg.devDependencies?.["@playwright/test"];
    expect(declared, "package.json declares no devDependencies['@playwright/test']").toBeDefined();
    expect(range).toBe(declared as string);
  });

  test('"^1.61.1" -> "1.61.1" -> the exact -noble image tag this cycle measured working', () => {
    const version = exactPlaywrightVersion("^1.61.1");
    expect(version).toBe("1.61.1");
    expect(dockerImageTag(version)).toBe("mcr.microsoft.com/playwright:v1.61.1-noble");
  });

  test("a bare version, a tilde range and a prerelease all resolve — a caret is not the only shape package.json could carry", () => {
    expect(exactPlaywrightVersion("1.61.1")).toBe("1.61.1");
    expect(exactPlaywrightVersion("~1.61.1")).toBe("1.61.1");
    expect(exactPlaywrightVersion("1.61.1-beta.2")).toBe("1.61.1");
  });

  test("a range with no exact version throws rather than silently guessing a tag", () => {
    expect(() => exactPlaywrightVersion("latest")).toThrow();
    expect(() => exactPlaywrightVersion("^1.61")).toThrow();
  });
});

describe("CR-CRU-018 — dockerRunArgs: the two mechanics the DN calls defects if missed", () => {
  const args = dockerRunArgs({ image: "mcr.microsoft.com/playwright:v1.61.1-noble", port: RUN_SERVER_PORT, playwrightVersion: "1.61.1" });

  test("adds --add-host=hostmachine:host-gateway — the container's localhost is not the host's", () => {
    expect(args).toContain(`--add-host=${HOSTMACHINE_ALIAS}:host-gateway`);
    expect(HOSTMACHINE_ALIAS).toBe("hostmachine");
  });

  test("runs the SAME pinned version's run-server inside the container — never an unpinned `npx playwright run-server`", () => {
    const shCommand = args[args.length - 1] as string;
    expect(shCommand).toContain("npx -y playwright@1.61.1 run-server");
    expect(shCommand).toContain(`--port ${String(RUN_SERVER_PORT)}`);
  });

  test("publishes the port to 127.0.0.1 only, and names a container this script can find again to remove it", () => {
    const publishIndex = args.indexOf("-p");
    expect(args[publishIndex + 1]).toBe(`127.0.0.1:${String(RUN_SERVER_PORT)}:${String(RUN_SERVER_PORT)}`);
    expect(args).toContain(CONTAINER_NAME);
    expect(args).toContain("--rm");
  });

  test("runServerWsEndpoint matches the port dockerRunArgs published", () => {
    expect(runServerWsEndpoint(RUN_SERVER_PORT)).toBe(`ws://127.0.0.1:${String(RUN_SERVER_PORT)}/`);
  });

  test("RUN_SERVER_PORT is neither E2E_PORT (39877) nor either workstation board (3849/3850) — it cannot collide with a supervised process", () => {
    expect(RUN_SERVER_PORT).not.toBe(39_877);
    expect(RUN_SERVER_PORT).not.toBe(3849);
    expect(RUN_SERVER_PORT).not.toBe(3850);
  });
});
