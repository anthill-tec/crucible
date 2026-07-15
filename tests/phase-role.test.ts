// CR-CRU-007 §S1 — Phase-role icon tinting (user-added during execution):
// the card's kind icon is tinted by the agent's PHASE ROLE derived from the
// agentId — RED -> red, GREEN -> green, VERIFY -> purple, FIX -> yellow
// (suffix -RED|-GREEN|-FIX or a verify/-VERIFY name segment,
// case-insensitive; roleless agents keep the neutral tint). A pure
// `L.phaseRole(agentId)` helper backs it.
//
// RED phase: `L.phaseRole` does not exist yet on public/app-logic.mjs (same
// not-yet-exported-name convention as tests/drill-in-mode.test.ts — a
// namespace import stays loadable, so `AppLogic.phaseRole(...)` fails at
// CALL time, that TypeError IS the RED signal) and public/app.js's
// EventCard never applies an `app-role-*` class to `[data-testid=
// "card-icon"]`.
//
// Contract this file defines for GREEN:
//   - `phaseRole(agentId)`: a `-RED`/`-GREEN`/`-FIX` SUFFIX (case-insensitive)
//     wins first -> "red" / "green" / "fix"; else a "verify" NAME SEGMENT
//     (agentId split on non-alphanumeric characters, case-insensitive exact
//     segment match — NOT a substring match, so "unverified-agent" does NOT
//     match) anywhere in the id -> "verify"; else `null`.
//   - DOM: `[data-testid="card-icon"]` carries `app-role-red` / `app-role-green`
//     / `app-role-verify` (purple) / `app-role-fix` (yellow) to match; a
//     roleless agent's card-icon carries NONE of those four classes.
import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as AppLogic from "../public/app-logic.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VAN_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-1.5.5.nomodule.min.js"), "utf8");
const VAN_X_SRC = readFileSync(path.join(REPO_ROOT, "public/vendor/van-x-0.6.3.nomodule.min.js"), "utf8");
const APP_JS_SRC = readFileSync(path.join(REPO_ROOT, "public/app.js"), "utf8");
const APP_LOGIC_PATH = path.join(REPO_ROOT, "public/app-logic.mjs");

describe("app-logic — phaseRole(agentId), pure (§S1 phase-role icon tinting)", () => {
  test("a -RED suffix (case-insensitive) resolves 'red'", () => {
    expect(AppLogic.phaseRole("CR-X-1-RED")).toBe("red");
    expect(AppLogic.phaseRole("cr-x-1-red")).toBe("red");
    expect(AppLogic.phaseRole("CR-X-1-Red")).toBe("red");
  });

  test("a -GREEN suffix (case-insensitive) resolves 'green'", () => {
    expect(AppLogic.phaseRole("CR-X-1-GREEN")).toBe("green");
    expect(AppLogic.phaseRole("cr-x-1-green")).toBe("green");
  });

  test("a -FIX suffix (case-insensitive) resolves 'fix'", () => {
    expect(AppLogic.phaseRole("CR-X-1-FIX")).toBe("fix");
    expect(AppLogic.phaseRole("cr-x-1-fix")).toBe("fix");
  });

  test("a verify/-VERIFY name segment (case-insensitive) resolves 'verify'", () => {
    expect(AppLogic.phaseRole("CR-X-1-VERIFY")).toBe("verify");
    expect(AppLogic.phaseRole("cr-x-1-verify")).toBe("verify");
    expect(AppLogic.phaseRole("verify-agent")).toBe("verify");
    expect(AppLogic.phaseRole("agent-VERIFY-runner")).toBe("verify");
    expect(AppLogic.phaseRole("verify")).toBe("verify");
  });

  test("a -RED/-GREEN/-FIX suffix takes precedence over an earlier verify segment", () => {
    expect(AppLogic.phaseRole("agent-verify-RED")).toBe("red");
    expect(AppLogic.phaseRole("agent-verify-GREEN")).toBe("green");
    expect(AppLogic.phaseRole("agent-verify-FIX")).toBe("fix");
  });

  test("bound: 'verify' must be a whole name SEGMENT, not a substring — 'unverified-agent' resolves null", () => {
    expect(AppLogic.phaseRole("unverified-agent")).toBeNull();
    expect(AppLogic.phaseRole("verifying-agent")).toBeNull();
  });

  test("bound: 'red'/'green'/'fix' embedded mid-word (not a trailing suffix) never resolves a role — 'redteam-agent' resolves null", () => {
    expect(AppLogic.phaseRole("redteam-agent")).toBeNull();
    expect(AppLogic.phaseRole("greenhouse-bot")).toBeNull();
    expect(AppLogic.phaseRole("fixture-agent")).toBeNull();
  });

  test("a roleless agentId resolves null", () => {
    expect(AppLogic.phaseRole("plain-agent-1")).toBeNull();
    expect(AppLogic.phaseRole("claude-sandesh")).toBeNull();
  });
});

interface EventFixture {
  id: string;
  projectKey: string;
  agentId: string;
  kind: "test" | "compile";
  tier: string;
  codec?: string;
  timestamp: number;
  total?: number;
  passed?: number;
  failed?: number;
  pending?: number;
  duration_ms?: number;
  hasCoverage?: boolean;
  errors?: number;
  warnings?: number;
}

interface ProjectFixture {
  key: string;
  name: string;
  type: "backend" | "frontend";
  agentsOnline: number;
  agentsTotal: number;
  active?: boolean;
  lastActivity?: number;
}

interface MountOpts {
  pathname?: string;
  projects?: ProjectFixture[];
  events?: EventFixture[];
}

let cacheBust = 0;

/** Same mountApp harness pattern as tests/run-cards.test.ts. */
async function mountApp(opts: MountOpts): Promise<void> {
  const pathname = opts.pathname ?? "/";
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  await GlobalRegistrator.register({ url: `http://localhost${pathname}` });
  document.body.innerHTML = '<div id="app"></div>';

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
    let body: unknown;
    if (url.includes("/api/v2/projects")) body = { ok: true, projects: opts.projects ?? [] };
    else if (url.includes("/api/v2/agents")) body = { ok: true, agents: [] };
    else if (url.includes("/api/v2/events")) body = { ok: true, events: opts.events ?? [] };
    else if (url.includes("/api/v2/health")) {
      body = { ok: true, version: "2.0.0-test", counts: { events: 0 } };
    } else throw new Error(`phase-role.test.ts mountApp: unexpected fetch url ${url}`);
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;

  (0, eval)(VAN_SRC);
  (0, eval)(VAN_X_SRC);

  cacheBust += 1;
  await import(`${APP_LOGIC_PATH}?phaseRole=${cacheBust}`);

  (0, eval)(APP_JS_SRC);

  await settle();
}

async function settle(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
});

const ROLE_CLASSES = ["app-role-red", "app-role-green", "app-role-verify", "app-role-fix"];

function baseEvent(id: string, agentId: string, projectKey: string, timestamp: number): EventFixture {
  return {
    id,
    projectKey,
    agentId,
    kind: "test",
    tier: "unit",
    codec: "junit",
    timestamp,
    total: 3,
    passed: 3,
    failed: 0,
    pending: 0,
    duration_ms: 100,
    hasCoverage: false,
  };
}

describe("§S1 phase-role icon tinting — DOM (run cards)", () => {
  test("run cards carry app-role-{red,green,verify,fix} on the kind icon per the agent's phase-role suffix", async () => {
    const now = Date.now();
    const projectKey = "proj-phase-role";
    await mountApp({
      pathname: "/",
      projects: [
        { key: projectKey, name: "Phase Role", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
      ],
      events: [
        baseEvent("evt-role-red", "CR-X-1-RED", projectKey, now - 5000),
        baseEvent("evt-role-green", "CR-X-1-GREEN", projectKey, now - 4000),
        baseEvent("evt-role-verify", "CR-X-1-VERIFY", projectKey, now - 3000),
        baseEvent("evt-role-fix", "CR-X-1-FIX", projectKey, now - 2000),
        baseEvent("evt-role-none", "plain-agent-1", projectKey, now - 1000),
      ],
    });

    const cards = document.querySelectorAll('[data-testid="event-card"]');
    expect(cards.length).toBe(5);

    function iconClassFor(agentId: string): string {
      const card = Array.from(cards).find((c) => (c.textContent ?? "").includes(agentId));
      expect(card).toBeDefined();
      const icon = card!.querySelector('[data-testid="card-icon"]');
      expect(icon).not.toBeNull();
      return icon!.className;
    }

    const redClass = iconClassFor("CR-X-1-RED");
    expect(redClass).toMatch(/\bapp-role-red\b/);
    for (const other of ROLE_CLASSES.filter((c) => c !== "app-role-red")) {
      expect(redClass).not.toMatch(new RegExp(`\\b${other}\\b`));
    }

    const greenClass = iconClassFor("CR-X-1-GREEN");
    expect(greenClass).toMatch(/\bapp-role-green\b/);

    const verifyClass = iconClassFor("CR-X-1-VERIFY");
    expect(verifyClass).toMatch(/\bapp-role-verify\b/);

    const fixClass = iconClassFor("CR-X-1-FIX");
    expect(fixClass).toMatch(/\bapp-role-fix\b/);

    // Roleless agent: NONE of the four role classes present.
    const noneClass = iconClassFor("plain-agent-1");
    for (const roleClass of ROLE_CLASSES) {
      expect(noneClass).not.toMatch(new RegExp(`\\b${roleClass}\\b`));
    }
  });

  test("phase-role tinting applies to compile-event (🛠) cards too, not just test-event cards", async () => {
    const now = Date.now();
    const projectKey = "proj-phase-role-compile";
    await mountApp({
      pathname: "/",
      projects: [
        { key: projectKey, name: "Phase Role Compile", type: "backend", agentsOnline: 0, agentsTotal: 0, active: true, lastActivity: now },
      ],
      events: [
        {
          id: "evt-role-compile-red",
          projectKey,
          agentId: "CR-Y-1-RED",
          kind: "compile",
          tier: "unit",
          codec: "rustc",
          timestamp: now,
          hasCoverage: false,
          errors: 1,
          warnings: 0,
        },
      ],
    });

    const card = document.querySelector('[data-testid="event-card"]');
    expect(card).not.toBeNull();
    const icon = card!.querySelector('[data-testid="card-icon"]');
    expect(icon).not.toBeNull();
    expect(icon!.textContent).toBe("🛠");
    expect(icon!.className).toMatch(/\bapp-role-red\b/);
  });
});
