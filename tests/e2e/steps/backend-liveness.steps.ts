// CR-CRU-007 C5b — F10 backend-down/reconnect steps: spawns a standalone
// `bun run src/server.ts` process (own port + scratch DB), kills it out
// from under a live page, and restarts it on the SAME port/db — lifted
// unchanged from the pre-conversion shell.e2e.ts "backend liveness" block.
// CR-CRU-052 §S5 — the scratch DB is now named EXPLICITLY via CRUCIBLE_DB
// rather than left to a cwd-relative default that stopped working in
// CR-CRU-043; see `spawnServer` below.
import { expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForHealth } from "./harness.ts";
import { After, Step } from "./world.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER_ENTRY = path.join(REPO_ROOT, "src", "server.ts");

/**
 * A port the kernel has just confirmed is free, then released — the e2e mirror
 * of the bun suites' `freePorts()`
 * (tests/server-listener-is-configuration.test.ts) and the python suites'
 * `_free_port()`.
 *
 * F10 used a FIXED 39878, which is a standing appointment with a collision: it
 * is held for a whole scenario, and it is the same number for every checkout,
 * every worker and every previous run that left a child behind. When it does
 * collide, the child exits and the scenario fails on `waitForHealth` — a
 * timeout that reads as a broken reconnect feature rather than as a busy port.
 * No port on this machine is this suite's to assume, and the one number it must
 * never reach for is :3849, the port a production install occupies.
 */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => {
          reject(new Error("the kernel gave this probe no numbered port to allocate from"));
        });
        return;
      }
      const { port } = address;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

// CR-CRU-052 §S5 — the SECOND leak site, found while proving the first one
// closed. This step spawns its OWN server (not the config's `webServer`), and
// it isolated the same way playwright.config.ts used to: scratch `cwd` only.
// Since CR-CRU-043 that isolates nothing — a scratch cwd is exactly what makes
// `resolveDbPath` miss its `<cwd>/data/crucible.db` probe and fall through to
// the persistent `~/.local/share/crucible/crucible.db`. MEASURED: with
// playwright.config.ts already fixed, a full e2e run still moved that file's
// WAL mtime twice, and an `lsof` poll caught a transient `bun` process holding
// it open — this spawner, once for the initial boot and once for the restart.
//
// `CRUCIBLE_DB` is therefore passed explicitly, and derived from `scratchCwd`
// so the restart — which is handed back the SAME scratchCwd — necessarily gets
// the SAME database. That is load-bearing for F10: the scenario asserts the
// page RECOVERS after the process is killed and restarted, which is only
// meaningful if the restarted server reopens the same store. Previously that
// held by accident, because the shared user-level DB persisted across both.
function dbFor(scratchCwd: string): string {
  return path.join(scratchCwd, "data", "crucible.db");
}

/**
 * CR-CRU-139 §S1/§S1b — the listener of a server started as a SUBPROCESS is
 * declared in that server's OWN `crucible.toml`, never exported at it:
 * `$CRUCIBLE_PORT` is retired and no longer read, so a child left to the
 * environment would fall through to the shipped default and bind :3849 — the
 * port a production install occupies. The file goes beside the store the child
 * is already handed, which is exactly where `serverConfigPath()` looks
 * (`dirname(CRUCIBLE_DB)/crucible.toml`), and the RESTART reads the same file
 * because it is handed the same scratch cwd.
 */
function declareListener(scratchCwd: string, port: number): void {
  const dir = path.dirname(dbFor(scratchCwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "crucible.toml"),
    `[server]\nhost = "127.0.0.1"\nport = ${String(port)}\n`,
  );
}

/**
 * Every child this module spawns, so a scenario that dies between the spawn
 * and its kill step cannot leave one running. An orphaned server is not merely
 * untidy: it HOLDS A PORT, and since CR-CRU-139 §S1 a server that outlives its
 * fixture is a listener nobody is tracking.
 */
const spawned = new Set<ChildProcess>();

function killAllSpawned(): void {
  for (const child of spawned) child.kill();
  spawned.clear();
}

for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.on(signal, killAllSpawned);
}

// ...and the same reaping at the end of every SCENARIO, which the signal
// handlers above cannot do: they fire when the RUN ends, so a scenario that
// throws between the spawn and its kill step leaves the child holding its port
// for every scenario after it. The last step's own `finally` only covers a
// scenario that reached that step. This hook covers the ones that did not.
After(() => {
  killAllSpawned();
});

function spawnServer(scratchCwd: string, port: number): ChildProcess {
  declareListener(scratchCwd, port);
  const child = spawn("bun", ["run", SERVER_ENTRY], {
    cwd: scratchCwd,
    env: {
      ...process.env,
      CRUCIBLE_DB: dbFor(scratchCwd),
    },
    stdio: "ignore",
  });
  spawned.add(child);
  child.once("exit", () => spawned.delete(child));
  return child;
}

Step("a standalone Crucible server is running on its own port", async ({ world, $testInfo }) => {
  $testInfo.setTimeout(90_000);
  const scratchCwd = mkdtempSync(path.join(tmpdir(), "crucible-e2e-f10-"));
  // Allocated once and carried in the world: the restart below must bind the
  // SAME port, because the page under test is already pointed at it.
  const port = await freePort();
  const baseUrl = `http://localhost:${port}`;
  const child = spawnServer(scratchCwd, port);
  await waitForHealth(baseUrl, 15_000);
  world.standalone = { baseUrl, child };
  world.standaloneScratchCwd = scratchCwd;
  world.standalonePort = port;
});

Step("I open that server's home page", async ({ page, world }) => {
  const standalone = world.standalone as { baseUrl: string; child: ChildProcess };
  await page.goto(standalone.baseUrl);
});

Step(
  'the health pill does not contain "unreachable" and shows a live-green dot',
  async ({ page }) => {
    const pill = page.getByTestId("health-pill");
    await expect(pill).not.toContainText("unreachable");
    await expect(pill.locator(".app-dot")).toHaveClass(/\bg\b/);
  },
);

Step("the standalone server process is killed", async ({ world }) => {
  const standalone = world.standalone as { baseUrl: string; child: ChildProcess };
  standalone.child.kill();
});

Step('the health pill contains "unreachable" within {int} seconds', async ({ page }, seconds: number) => {
  await expect(page.getByTestId("health-pill")).toContainText("unreachable", {
    timeout: seconds * 1_000,
  });
});

Step("the timeline is greyed within {int} seconds", async ({ page }, seconds: number) => {
  await expect(page.getByTestId("timeline")).toHaveClass(/greyed/, { timeout: seconds * 1_000 });
});

Step(
  "the standalone server process is restarted on the same port and scratch database",
  async ({ world }) => {
    const standalone = world.standalone as { baseUrl: string; child: ChildProcess };
    const scratchCwd = world.standaloneScratchCwd as string;
    const child = spawnServer(scratchCwd, world.standalonePort as number);
    await waitForHealth(standalone.baseUrl, 15_000);
    world.standalone = { baseUrl: standalone.baseUrl, child };
  },
);

Step(
  'the health pill no longer contains "unreachable" within {int} seconds',
  async ({ page }, seconds: number) => {
    await expect(page.getByTestId("health-pill")).not.toContainText("unreachable", {
      timeout: seconds * 1_000,
    });
  },
);

Step(
  "the timeline is no longer greyed within {int} seconds",
  async ({ page, world }, seconds: number) => {
    try {
      await expect(page.getByTestId("timeline")).not.toHaveClass(/greyed/, {
        timeout: seconds * 1_000,
      });
    } finally {
      const standalone = world.standalone as { baseUrl: string; child: ChildProcess } | undefined;
      standalone?.child.kill();
    }
  },
);
