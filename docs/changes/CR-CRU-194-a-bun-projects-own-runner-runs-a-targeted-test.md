# CR-CRU-194 — a bun project's own runner runs a targeted test, and no project is anyone's default

**Type** fix · **Points** 8 (5 at filing 2026-10-18, raised when the test-name filter moved in from
CR-CRU-190 on 2026-10-19; confirmed at gap analysis) · **Wave** 8 (0.4.0) · **Depends on** — ·
**Status** PENDING — filed 2026-10-18 (Model B request, user ruling: its own CR in 0.4.0; the
test-name filter joined it from CR-CRU-190, user ruling 2026-10-19)

## Problem

Raised by Model B (2026-10-18), from a Bun frontend project whose packages run Vitest on the Bun
runtime and keep `bun test` for structural gates only.

1. **A targeted run ignores the project's runner.** The tier verbs run a declared `package.json`
   script by name and never classify the runner behind it, so they already serve Vitest-under-Bun:
   `unit -- <file>` runs `bun run test:unit -- <file>`. But `test --tests <file>`, the RED and GREEN
   agents' everyday run, always builds `bun test --timeout … <file>`. Bun's own runner cannot run
   those suites: it lacks `vi.mock` hoisting and async mock factories, and its `mock.module` leaks
   across files.
2. **The package-dir default names one project.** The package dir every verb runs in (`check`'s
   `tsc`, `test`, `regression`, the tier verbs, `pre-merge-gate`) falls back from `--package-dir` to
   `$BUN_CRUCIBLE_PACKAGE_DIR`, then to `<project>/integrations/pi` when that holds a
   `package.json`, then to the project root. `integrations/pi` is Sandesh's layout. The client's
   own help example (`src/tools/send.test.ts`, agent `CR-SAN-013-C1-RED`, `claude-sandesh`) is
   Sandesh's too. A relative `--package-dir` is resolved against the project root, but a relative
   `$BUN_CRUCIBLE_PACKAGE_DIR` is left relative to the working directory.
3. **A targeted run cannot pick one test.** Requested by Model B (Sandesh #1446). An agent iterating
   on one test can only run its whole file: `test` has no form for `bun test -t`, nor for the same
   filter through a declared runner.

## Design (settled with the user, 2026-10-18 and 2026-10-19)

- **The targeted run goes through a declared script.** A project may declare the `package.json`
  script a targeted `test --tests <files>` runs through. When it does, the run is
  `bun run <script> -- <files>`, under that script's own report mechanism
  (`crucible.reportPath.<script>`), exactly as a tier verb runs a declared script. With no
  declaration the run is `bun test`, unchanged. Agents keep their one verb.
- **The package dir is configuration.** The `integrations/pi` fallback is removed. A project
  declares its package dir in its own `crucible.toml`, resolved through the same project → install
  → shipped chain as `[client]` and `[gate]`. The order becomes `--package-dir`, then
  `$BUN_CRUCIBLE_PACKAGE_DIR`, then the declared value, then the project root.
- **The proof is a real Vitest project** (user ruling, 2026-10-19): `vitest` becomes a dev
  dependency of this repo, and a committed Vitest fixture project runs under Bun in the suite.

## Scope

### §S1 — a targeted run under the declared runner

The declaration is `crucible.testScript` in `package.json`, beside `crucible.reportPath`, naming a
script of the same file's script table. With it, `test --tests <files>` runs
`bun run <script> -- <files>`, with the report mechanism `crucible.reportPath.<script>` declares
(`flag` or `env:<VAR>`), exactly as a tier verb runs a declared script. The run claims no tier, as
every `test` run does. A `crucible.testScript` naming a script the table does not hold is refused
before anything runs, naming the script and `package.json`. The envelope names the script the run
went through. Without the declaration, the run is today's `bun test` invocation.

### §S2 — the package dir is declared, never assumed

The `integrations/pi` step leaves the client. A project declares its package dir as
`[bun] package_dir` in its `crucible.toml`, read through the same project → install → shipped chain
as `[client]` and `[gate]`; the shipped file documents the key and declares no value. The order is
`--package-dir`, `$BUN_CRUCIBLE_PACKAGE_DIR`, the declared value, the project root. A relative value
from any of the three is resolved against the project root. A value that is not a directory holding
a `package.json` is refused, naming the value and where it came from (the flag, the variable, or the
file that declared it). Every verb that runs in the package dir follows the resolution.

### §S3 — a targeted run filters by test name

`test` gains `--name <pattern>`. On the `bun test` path it is passed as `-t <pattern>`; through a
declared script it is passed after `--` as `-t <pattern>`, the flag Bun's runner and Vitest share.
The run is filed under the same cycle as any other `test` run, and its envelope names the filter.

### §S4 — help names no project

`test --help` and `--package-dir`'s help state the new resolution, the declared test script and the
name filter. No help text or example names `integrations/pi`, Sandesh, or one of Sandesh's tests
or agents.

### §S5 — a real Vitest project proves it

`vitest` is a dev dependency of this repo. A committed fixture project runs Vitest on the Bun
runtime, with its `vitest.config` reading its JUnit output path from the variable its
`crucible.reportPath` declares (`env:<VAR>`); Vitest does not take `bun test`'s report flags. The
fixture's test files are named outside `bun test`'s discovery pattern, so this repo's own suite and
CI never collect them under Bun's runner.

## Acceptance criteria

- [ ] **A declared targeted run uses the project's runner.** In the Vitest fixture project, with
      `crucible.testScript` declared, `test --tests <file>` spawns `bun run <script> -- <file>` and
      ingests the counts Vitest reported through the declared env mechanism (a fixture file with a
      passing and a failing test files one pass and one fail), and the envelope names the script.
- [ ] **No declaration, no change.** Without `crucible.testScript`, `test --tests <file>` spawns the
      same `bun test --timeout <default> <file>` invocation, with the same report flags, as before.
- [ ] **A bad declaration is refused.** A `crucible.testScript` the script table does not hold is
      refused before any run starts, and the refusal names the script and `package.json`.
- [ ] **The package dir is declared.** A project `crucible.toml` declaring `[bun] package_dir` makes
      it the directory `check`, `test`, `regression`, a tier verb and `pre-merge-gate` each run in,
      with no flag or environment variable set. The flag and the variable still win, in that order.
      A relative value from each of the three resolves against the project root.
- [ ] **No project is anyone's default.** With nothing declared, a project holding
      `integrations/pi/package.json` runs from the project root. No help text or example names
      `integrations/pi`, Sandesh or one of its tests or agents.
- [ ] **A bad package dir is refused,** naming the value and where it came from, for each of the
      flag, the variable and the declaration.
- [ ] **Name filter, both paths.** `test --name <pattern>` runs only the matching test on the
      `bun test` path (a fixture with two tests, one matching) and through the declared Vitest
      script, files that count, and its envelope names the filter.
- [ ] **The fixture stays out of this repo's suite.** `bun test` from the repo root, and the bun
      client's `regression`, collect none of the Vitest fixture's test files.
- [ ] **No new CR literals.** No CR-shaped literal is added in `src/`, `public/` or `clients/`, the
      citation tripwire's pins are unchanged, and the citations already on rewritten lines are kept.

## How it is worked

Sandesh is told, when 0.4.0 ships, that it must declare `[bun] package_dir`. Model B hears of the
declared test script and `--name` in the 0.4.0 release notes.

## Non-goals

- Classifying a runner from a script's body. What runs is still the declaration, by name.
- A tier for a targeted run; only a tier verb states one.
- Coverage for a targeted run.
