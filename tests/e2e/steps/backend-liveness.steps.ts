// CR-CRU-007 C5b — F10 backend-down/reconnect steps: spawns a standalone
// `bun run src/server.ts` process (own port + scratch DB), kills it out
// from under a live page, and restarts it on the SAME port/db — lifted
// unchanged from the pre-conversion shell.e2e.ts "backend liveness" block.
import { expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForHealth } from "./harness.ts";
import { Step } from "./world.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER_ENTRY = path.join(REPO_ROOT, "src", "server.ts");
const STANDALONE_PORT = 39_878;

function spawnServer(scratchCwd: string, port: number): ChildProcess {
  return spawn("bun", ["run", SERVER_ENTRY], {
    cwd: scratchCwd,
    env: { ...process.env, CRUCIBLE_PORT: String(port) },
    stdio: "ignore",
  });
}

Step("a standalone Crucible server is running on its own port", async ({ world, $testInfo }) => {
  $testInfo.setTimeout(90_000);
  const scratchCwd = mkdtempSync(path.join(tmpdir(), "crucible-e2e-f10-"));
  const baseUrl = `http://localhost:${STANDALONE_PORT}`;
  const child = spawnServer(scratchCwd, STANDALONE_PORT);
  await waitForHealth(baseUrl, 15_000);
  world.standalone = { baseUrl, child };
  world.standaloneScratchCwd = scratchCwd;
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
    const child = spawnServer(scratchCwd, STANDALONE_PORT);
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
