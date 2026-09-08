#!/usr/bin/env bun
// Run ONE test target. See scripts/test-targets.ts for why targets exist and
// how membership is derived.
//
//   bun run test:unit           fast feedback: no browser, no spawns, no server
//   bun run test:integration    the real thing: browser, clients, HTTP, live board
//   bun run test:client         the 65-file python client suite (1445 tests)
//   bun run test:regression     everything: the WHOLE bun suite + the python suite
//
// `regression` deliberately runs `bun test` with NO path arguments — the same
// single invocation the gate has always used, so the target switch cannot
// change what a full run collects. Extra arguments are passed straight through
// (`bun run test:unit -- --coverage`).

import { spawn } from "node:child_process";
import { partitionTestFiles, REPO_ROOT } from "./test-targets";

const TARGETS = ["unit", "integration", "client", "regression"] as const;
type Target = (typeof TARGETS)[number];

const isTarget = (value: string): value is Target => TARGETS.includes(value as Target);

async function run(command: string, args: string[]): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  const child = spawn(command, args, { cwd: REPO_ROOT, stdio: "inherit" });
  child.on("close", (code) => {
    resolve(code ?? 1);
  });
  return promise;
}

const [target, ...passthrough] = process.argv.slice(2);

if (target === undefined || !isTarget(target)) {
  process.stderr.write(`usage: bun scripts/run-test-target.ts <${TARGETS.join("|")}> [args...]\n`);
  process.exit(2);
}

// The python client suite: `tests/client/` is 67 files of `unittest` cases that
// `bun test` cannot see at all. Before 2026-09-08 no gate ran them, and a
// shipped CR (CR-CRU-108) had broken one without anything reporting it.
const PYTHON_SUITE = ["-m", "unittest", "discover", "-s", "tests/client", "-t", "."];

let exitCode = 0;

if (target === "client") {
  exitCode = await run("python3", [...PYTHON_SUITE, ...passthrough]);
} else if (target === "regression") {
  const bun = await run("bun", ["test", ...passthrough]);
  const python = await run("python3", PYTHON_SUITE);
  exitCode = bun !== 0 ? bun : python;
} else {
  const files = (await partitionTestFiles())[target];
  if (files.length === 0) {
    process.stderr.write(`target ${target} matched no test files — refusing to report a green run\n`);
    process.exit(1);
  }
  process.stderr.write(`[${target}] ${String(files.length)} files\n`);
  exitCode = await run("bun", ["test", ...files, ...passthrough]);
}

process.exit(exitCode);
