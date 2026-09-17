#!/usr/bin/env bun
// Run ONE test target. See scripts/test-targets.ts for why targets exist and
// how membership is derived.
//
//   bun run test:unit           fast feedback: no browser, no spawns, no server
//   bun run test:integration    the real thing: browser, clients, HTTP, live board
//   bun run test:regression     everything: the WHOLE bun suite + the python suite
//
// `test:client` no longer routes through here: CR-CRU-112 §S1 made it declare
// its own stack (`python3 -m unittest discover -s tests/client -t .`), which is
// what lets the pre-merge gate dispatch that suite to `python-crucible.py`
// instead of running it blind. The `client` target below still answers a direct
// `bun scripts/run-test-target.ts client`, and it runs the SAME discovery: the
// python client suite is 73 files / 1622 tests (measured 2026-09-08 — it was
// 65 / 1445 when this comment was written, which is why a frozen figure here
// is a liability and this one carries its date).
//
// `regression` deliberately runs `bun test` with NO path arguments — the same
// single invocation the gate has always used, so the target switch cannot
// change what a full run collects. Extra arguments are passed straight through
// (`bun run test:unit -- --coverage`).

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { partitionTestFiles, REPO_ROOT } from "./test-targets";

const TARGETS = ["unit", "integration", "client", "regression"] as const;
type Target = (typeof TARGETS)[number];

const isTarget = (value: string): value is Target => TARGETS.includes(value as Target);

// THE DEFAULT PER-TEST BUDGET (CR-CRU-137 §S1) — DERIVED, never retyped.
//
// This script is the THIRD `bun test` invocation path in the project, and the
// one a tier run arrives at: `bun-crucible.py`'s `unit`/`integration` verbs run
// the declared script BY NAME (`bun run test:<tier>`), so the client's own
// `--timeout` never reaches this command — before this, a tier run silently
// fell back to bun's 5000 ms default, which is the defect §S1 exists to end.
//
// The figure is DECLARED once, in `clients/bun-crucible.py`'s
// DEFAULT_TEST_TIMEOUT_MS, and that declaration stays authoritative: it is the
// CLIENT's choice, portable to whatever package it is pointed at, so it cannot
// move into this repo's `package.json` without making the client's default a
// property of the project it happens to be running. TypeScript cannot import a
// Python constant, so this path READS it — at run time, from the one file that
// declares it. A rename or a second declaration does not degrade to bun's
// default: it REFUSES to run, because silently inheriting a budget nobody chose
// is precisely the failure being fixed.
const TIMEOUT_DECLARATION_REL = join("clients", "bun-crucible.py");
const TIMEOUT_DECLARATION = /^DEFAULT_TEST_TIMEOUT_MS\s*=\s*(\d[\d_]*)\s*$/gm;

function declaredTimeoutArgs(): string[] {
  const declaration = join(REPO_ROOT, TIMEOUT_DECLARATION_REL);
  const matches = [...readFileSync(declaration, "utf8").matchAll(TIMEOUT_DECLARATION)];
  if (matches.length !== 1) {
    process.stderr.write(
      `${TIMEOUT_DECLARATION_REL} declares DEFAULT_TEST_TIMEOUT_MS ${String(matches.length)} times; ` +
        `this runner derives the suite's per-test budget from exactly one declaration and will not ` +
        `fall back to bun's default\n`,
    );
    process.exit(2);
  }
  const digits = (matches[0] as RegExpMatchArray)[1] as string;
  return ["--timeout", digits.replace(/_/g, "")];
}

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

// The python client suite: `tests/client/` is 73 files of `unittest` cases that
// `bun test` cannot see at all. Before 2026-09-08 no gate ran them, and a
// shipped CR (CR-CRU-108) had broken one without anything reporting it. This
// path ingests NOTHING — that is the finding CR-CRU-112 closes: the gate reads
// the project's declaration and dispatches the suite to its own stack's client,
// so a run of it is attributable; this script stays the developer convenience.
const PYTHON_SUITE = ["-m", "unittest", "discover", "-s", "tests/client", "-t", "."];

let exitCode = 0;

if (target === "client") {
  exitCode = await run("python3", [...PYTHON_SUITE, ...passthrough]);
} else if (target === "regression") {
  // The budget goes ahead of the passthrough, so `-- --timeout 5001` still
  // overrides it: bun honours the LAST spelling on the command line.
  const bun = await run("bun", ["test", ...declaredTimeoutArgs(), ...passthrough]);
  const python = await run("python3", PYTHON_SUITE);
  exitCode = bun !== 0 ? bun : python;
} else {
  const files = (await partitionTestFiles())[target];
  if (files.length === 0) {
    process.stderr.write(`target ${target} matched no test files — refusing to report a green run\n`);
    process.exit(1);
  }
  process.stderr.write(`[${target}] ${String(files.length)} files\n`);
  exitCode = await run("bun", ["test", ...declaredTimeoutArgs(), ...files, ...passthrough]);
}

process.exit(exitCode);
