#!/usr/bin/env bun
// Run ONE test target. A tier is its DIRECTORY: a test file belongs to the
// tier whose directory holds it, and the target runs that directory by path.
//
//   bun run test:unit           tests/unit: no browser, no spawns, no server
//   bun run test:integration    tests/integration: browser, clients, HTTP, live board
//   bun run test:regression     everything: the WHOLE bun suite + the python suite
//
// `unit` and `integration` spawn exactly one `bun test --timeout <declared>
// ./tests/<tier>` — the `./` makes the argument a directory, not a name filter.
// A tier directory holding no test file refuses to run rather than report a
// green run of nothing.
//
// The python client suite declares its own scripts (`test:client-unit`,
// `test:client-integration`, each a `python3 -m unittest discover -s
// tests/client/<tier> -t .`), which is what lets the pre-merge gate dispatch
// them to `python-crucible.py` instead of running them blind.
//
// `regression` deliberately runs `bun test` with NO path arguments — the same
// single invocation the gate has always used — and then the python discovery
// over `tests/client`, which collects both python tiers. Extra arguments are
// passed straight through (`bun run test:unit -- --coverage`).

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "./repo-root";

const TARGETS = ["unit", "integration", "regression"] as const;
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

// The file names `bun test` collects: `*.test.*`, `*_test.*`, `*.spec.*` and
// `*_spec.*` over the JS/TS extensions.
const BUN_TEST_FILE = /[._](?:test|spec)\.[cm]?[jt]sx?$/;

/** How many test files `bun test` would collect under a tier directory. */
async function countTestFiles(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    },
  );
  return entries.filter((entry) => entry.isFile() && BUN_TEST_FILE.test(entry.name)).length;
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

// The python client suite, both tiers: `regression`'s python half. This path
// ingests NOTHING — the gate reads the project's declared `test:client-<tier>`
// scripts and dispatches each to its own stack's client, so a run of it is
// attributable; this script stays the developer convenience.
const PYTHON_SUITE = ["-m", "unittest", "discover", "-s", "tests/client", "-t", "."];

let exitCode = 0;

if (target === "regression") {
  // The budget goes ahead of the passthrough, so `-- --timeout 5001` still
  // overrides it: bun honours the LAST spelling on the command line.
  const bun = await run("bun", ["test", ...declaredTimeoutArgs(), ...passthrough]);
  const python = await run("python3", PYTHON_SUITE);
  exitCode = bun !== 0 ? bun : python;
} else {
  const tierDir = `./tests/${target}`;
  const files = await countTestFiles(join(REPO_ROOT, "tests", target));
  if (files === 0) {
    process.stderr.write(`target ${target}: ${tierDir} holds no test file — refusing to report a green run\n`);
    process.exit(1);
  }
  process.stderr.write(`[${target}] ${tierDir}: ${String(files)} files\n`);
  exitCode = await run("bun", ["test", ...declaredTimeoutArgs(), tierDir, ...passthrough]);
}

process.exit(exitCode);
