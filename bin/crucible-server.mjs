#!/usr/bin/env node
// npx-runnable launcher for the Crucible bun/node server (CR-CRU-009 §S4).
//
// The server entry is `src/server.ts` (a Bun program: `Bun.serve` +
// `import.meta.main`). This shim locates that entry relative to the installed
// package and execs it under Bun, forwarding argv + the child's exit code.
// Bun is self-provisioned by `crucible-axi install` (curl-installer) when
// absent — see docs/RUNBOOK.md for the loopback default + CRUCIBLE_PORT /
// CRUCIBLE_HOST config.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, "..", "src", "server.ts");

const child = spawn("bun", ["run", serverEntry, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (err) => {
  console.error(`crucible-server: failed to launch bun on ${serverEntry}: ${err.message}`);
  process.exit(127);
});
