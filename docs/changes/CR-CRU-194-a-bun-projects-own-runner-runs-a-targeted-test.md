# CR-CRU-194 — a bun project's own runner runs a targeted test, and no project is anyone's default

**Type** fix · **Points** 8 (provisional; 5 at filing 2026-10-18, raised when the test-name filter
moved in from CR-CRU-190 on 2026-10-19; the estimate is revisited at gap analysis) · **Wave** 8 (0.4.0) · **Depends on** — ·
**Status** PENDING — filed 2026-10-18 (Model B request, user ruling: its own CR in 0.4.0; the test-name filter joined it from CR-CRU-190, user
ruling 2026-10-19)

## Problem

Raised by Model B (2026-10-18), from a Bun frontend project whose packages run Vitest on the Bun
runtime and keep `bun test` for structural gates only.

1. **A targeted run ignores the project's runner.** The tier verbs run a declared `package.json`
   script by name and never classify the runner behind it, so they already serve Vitest-under-Bun:
   `unit -- <file>` runs `bun run test:unit -- <file>`. But `test --tests <file>`, the RED and GREEN
   agents' everyday run, always builds `bun test --timeout … <file>`. Bun's own runner cannot run
   those suites: it lacks `vi.mock` hoisting and async mock factories, and its `mock.module` leaks
   across files.
2. **The package-dir default names one project.** `--package-dir` falls back to
   `$BUN_CRUCIBLE_PACKAGE_DIR`, then to `<project>/integrations/pi` when that holds a
   `package.json`, then to the project root. `integrations/pi` is Sandesh's layout. The client's
   own help example (`src/tools/send.test.ts`, agent `CR-SAN-013-C1-RED`) is Sandesh's too.
3. **A targeted run cannot pick one test.** Requested by Model B (Sandesh #1446). An agent
   iterating on one test can only run its whole file: `test` has no form for `bun test -t`, nor
   for the same filter through a declared runner.

## Design (settled with the user, 2026-10-18)

- **The targeted run goes through a declared script.** A project may declare the `package.json`
  script a targeted `test --tests <files>` runs through. When it does, the run is
  `bun run <script> -- <files>`, under that script's own report-path mechanism
  (`crucible.reportPath.<script>`), exactly as a tier verb runs it. With no declaration the run is
  `bun test`, unchanged. Agents keep their one verb.
- **The package dir is configuration.** The `integrations/pi` fallback is removed. A project
  declares its package dir in its own `crucible.toml`, resolved through the same project → install
  → shipped chain as `[client]` and `[gate]`. The order becomes `--package-dir`, then
  `$BUN_CRUCIBLE_PACKAGE_DIR`, then the declared value, then the project root.

## Scope

### §S1 — a targeted run under the declared runner

The declaration lives beside the script table and the report-path declaration it reuses. A
declaration naming a script the table does not hold is refused before anything runs, naming the
script and the file. The envelope says which runner the run went through.

### §S2 — the package dir is declared, never assumed

The `integrations/pi` step and every Sandesh-specific example leave the client. A declared value
that is not a directory holding a `package.json` is refused, naming the value and the file it came
from.

### §S3 — a targeted run filters by test name

`test` gains `--name <pattern>`. On the `bun test` path it is passed as `-t <pattern>`; through a
declared script it is passed after `--` as `-t <pattern>`, the flag Bun's runner and Vitest share.
The run is filed under the same tier and cycle as any other `test` run, and its envelope names the
filter.

### §S4 — help and the fleet manifest say so

`test --help` and `--package-dir`'s help state the new resolution and the name filter, and the
examples name no project.

## Acceptance criteria

- [ ] **A declared targeted run uses the project's runner.** With a targeted-run script declared,
      `test --tests <file>` spawns `bun run <script> -- <file>` and ingests the report the script's
      declared mechanism produced. Proved with a real Vitest project run under Bun.
- [ ] **No declaration, no change.** Without one, `test --tests <file>` spawns the same `bun test`
      invocation as before.
- [ ] **A bad declaration is refused.** A declared script the table does not hold is refused before
      any run starts, and the refusal names the script and `package.json`.
- [ ] **The package dir is declared.** A project `crucible.toml` declaring the package dir makes it
      the run's cwd with no flag or environment variable set. The flag and the variable still win,
      in that order.
- [ ] **No project is anyone's default.** With nothing declared, a project holding
      `integrations/pi/package.json` runs from the project root. No help text or example names
      `integrations/pi`, Sandesh or one of its tests.
- [ ] **A bad package dir is refused,** naming the value and the file that declared it.
- [ ] **Name filter, both paths.** `test --name <pattern>` runs only the matching test, on the
      `bun test` path and through a declared Vitest script (a fixture with two tests, one
      matching), is filed with that count, and its envelope names the filter.

## Non-goals

- Classifying a runner from a script's body. What runs is still the declaration, by name.
