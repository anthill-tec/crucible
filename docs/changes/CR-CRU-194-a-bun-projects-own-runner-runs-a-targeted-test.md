# CR-CRU-194 — a bun project's own runner runs a targeted test, and no project is anyone's default

**Type** fix · **Points** 8 (5 at filing 2026-10-18, raised when the test-name filter moved in from
CR-CRU-190 on 2026-10-19; confirmed at gap analysis and its pre-review) · **Wave** 8 (0.4.0) ·
**Depends on** — · **Status** PENDING — filed 2026-10-18 (Model B request, user ruling: its own CR in
0.4.0; the test-name filter joined it from CR-CRU-190, user ruling 2026-10-19)

## Problem

Raised by Model B (2026-10-18), from a Bun frontend project whose packages run Vitest on the Bun
runtime and keep `bun test` for structural gates only.

1. **A targeted run ignores the project's runner.** The tier verbs run a declared `package.json`
   script by name and never classify the runner behind it: under the default `flag` mechanism
   `unit -- <file>` runs `bun run test:unit <report flags> -- <file>`. But `test --tests <file>`,
   the RED and GREEN agents' everyday run, always builds `bun test --timeout … <file>`. Bun's own
   runner cannot run Vitest suites: it lacks `vi.mock` hoisting and async mock factories, and its
   `mock.module` leaks across files.
2. **Passthrough is lost under the `flag` mechanism.** When report flags come before the `--`,
   `bun run` forwards the `--` itself to the script, and `bun test` reads everything after it as a
   file filter. So `unit -- -t <pattern>` today finds no tests, and any filter passed that way is
   dropped. Measured on bun 1.4.2: the same invocation with no `--` filters correctly.
3. **The package-dir default names one project.** The package dir that `check`, `test`,
   `regression`, the five tier verbs, `auto-ingest` and `pre-merge-gate` run in (and that a relative
   `--reports` is resolved under) falls back from `--package-dir` to `$BUN_CRUCIBLE_PACKAGE_DIR`,
   then to `<project>/integrations/pi` when that holds a `package.json`, then to the project root.
   `integrations/pi` is Sandesh's layout, and the printed `--tests` help example
   (`src/tools/send.test.ts`) is Sandesh's test. A relative `--package-dir` is resolved against the
   project root, but a relative `$BUN_CRUCIBLE_PACKAGE_DIR` is left relative to the working
   directory.
4. **A targeted run cannot pick one test.** Requested by Model B (Sandesh #1446). An agent iterating
   on one test can only run its whole file: `test` has no form for `bun test -t`, nor for the same
   filter through a declared runner.

## Design (settled with the user, 2026-10-18 and 2026-10-19)

- **The targeted run goes through a declared script.** A project may declare the `package.json`
  script `test` runs through. When it does, the run is `bun run <script>` with the files and filter
  passed on, under that script's own report mechanism (`crucible.reportPath.<script>`), exactly as a
  tier verb runs a declared script. With no declaration the run is `bun test`, unchanged.
- **The package dir is configuration,** declared in the project's own `crucible.toml`. The
  `integrations/pi` fallback is removed.
- **The passthrough builder is fixed for every declared script,** the tier verbs included (user
  ruling, 2026-10-19).
- **A bad package dir:** the flag and the variable are refused only when they are not a directory;
  a declared value must also hold a `package.json` (user ruling, 2026-10-19).
- **The proof is a real Vitest project** (user ruling, 2026-10-19): `vitest` becomes a dev
  dependency of this repo, and a committed Vitest fixture project runs on the Bun runtime in the
  suite.

## Scope

### §S1 — `test` runs through the declared script

The declaration is `crucible.testScript` in `package.json`, beside `crucible.reportPath`: a string
naming a script of the same file's script table. With it, every `test` run (targeted by `--tests`
or not, filtered by `--name` or not) is `bun run <script>` with the files and the filter passed on,
under the report mechanism `crucible.reportPath.<script>` declares, including a `crucible.rawReport`
declaration, exactly as a tier verb runs a declared script; a starved script is reported in the
same words, naming the script. The run claims no tier, as every `test` run does. A
`crucible.testScript` that is not a string, or names a script the table does not hold or whose body
is empty, is refused before anything is posted to the board, with `ok: false`, exit 1, and the
refusal names the script and `package.json`. The envelope's `script` field names the script the run
went through. Without the declaration, the run is today's `bun test` invocation.

### §S2 — passthrough reaches the script under every mechanism

When the builder appends report flags, it passes the files, the filter and a tier verb's
passthrough after them with no `--`, so `bun run` hands them to the script's command as written.
Under `env:<VAR>` (nothing appended) the invocation is unchanged. This holds for `test` and for
every tier verb.

### §S3 — a targeted run filters by test name

`test` gains `--name <pattern>`, a regular expression passed unchanged as `-t <pattern>`: to
`bun test` on the default path, and to the declared script under §S2's rule. The run is filed under
the same cycle as any other `test` run. Tests the filter excludes are filed as pending, as the
runner reports them. A filtered run in which nothing passed and nothing failed is a run that ran
nothing: it is aborted, the envelope reads `ok: false`, the command exits 1, and its warning names
the pattern. The envelope's `name` field names the filter.

### §S4 — the package dir is declared, never assumed

The `integrations/pi` step leaves the client. A project declares its package dir as
`[bun] package_dir` in its own `crucible.toml`, read from the project's file only, never from an
install-level `crucible.toml`, since an install-wide package dir would make one project everyone's
default. The shipped
`crucible.toml` documents the key and declares no value. The order is `--package-dir`,
`$BUN_CRUCIBLE_PACKAGE_DIR`, the declared value, the project root. A relative value from any of the
three is resolved against the project root. A flag or variable value that is not a directory, and
a declared value that is not a directory holding a `package.json`, are refused before anything is
posted to the board, with `ok: false`, exit 1, naming the value and where it came from. Every verb
that runs in the package dir follows the resolution.

### §S5 — printed help names no project

`test --help` states the declared test script and the name filter; `--package-dir`'s help states
the new resolution. No printed help text or example names `integrations/pi`, Sandesh, or one of
Sandesh's tests or agents. The module docstrings, which are not printed, stay as the design record.

### §S6 — a real Vitest project proves it

`vitest` is a dev dependency of this repo, and `bun.lock` is updated in the same change. A committed
fixture project runs Vitest on the Bun runtime: its declared script launches Vitest with `--bun`,
its `vitest.config` sets `include` to the fixture's own file naming and reads its JUnit output path
from the variable its `crucible.reportPath` declares (`env:<VAR>`), since Vitest does not take
`bun test`'s report flags. The fixture's test files are named outside `bun test`'s discovery
patterns (`*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`), and the tests that drive it run it from a
scratch copy, so Vitest's caches and the client's reports are never written into the checkout.

## Acceptance criteria

- [ ] **A declared targeted run uses the project's runner.** In the Vitest fixture, with
      `crucible.testScript` declared, `test --tests <file>` spawns `bun run <script>` with the file,
      and ingests the counts Vitest reported through the declared env mechanism (a fixture file with
      one passing and one failing test files 1 passed, 1 failed); a fixture test proves the runtime
      is Bun; the envelope's `script` field names the script. A whole-suite `test` runs through the
      script too.
- [ ] **No declaration, no change.** Without `crucible.testScript`, `test --tests <file>` spawns the
      same `bun test --timeout <default> <file>` invocation, with the same report flags, as before,
      and the existing `_bun_test_cmd` callers keep working.
- [ ] **A bad declaration is refused.** A `crucible.testScript` that is not a string, names a script
      the table does not hold, or names one with an empty body, is refused before anything is posted
      to the board: `ok: false`, exit 1, naming the script and `package.json`.
- [ ] **Passthrough reaches the script.** Under the `flag` mechanism, `unit -- -t <pattern>` on a
      declared `bun test` script runs only the matching test, and `test --name <pattern>` through a
      declared `bun test` script does the same; under `env:<VAR>` the invocation is unchanged.
- [ ] **Name filter, every path.** `test --name <pattern>` on a two-test fixture with one match
      files 1 passed and 1 pending on the `bun test` path, through a declared `bun test` script under
      `flag`, and through the declared Vitest script; the envelope's `name` field names the filter. A
      pattern matching nothing aborts the run: `ok: false`, exit 1, a warning naming the pattern.
- [ ] **The package dir is declared.** A project `crucible.toml` declaring `[bun] package_dir` makes
      it the directory `check`, `test`, `regression`, a tier verb, `auto-ingest` and `pre-merge-gate`
      each run in, with no flag or variable set. The flag and the variable still win, in that order.
      A relative value from each of the three resolves against the project root.
- [ ] **No project is anyone's default.** With nothing declared, a project holding
      `integrations/pi/package.json` runs from the project root. No printed help text or example
      names `integrations/pi`, Sandesh or one of its tests or agents.
- [ ] **A bad package dir is refused** before anything is posted to the board, with `ok: false` and
      exit 1, naming the value and its source: a flag or variable value that is not a directory, and
      a declared value that is not a directory holding a `package.json`.
- [ ] **The fixture stays out of this repo's suite.** `bun test` from the repo root, this repo's
      `test:unit`, `test:integration` and `test:regression` scripts, the bun client's `regression`,
      and CI's `bun test --timeout 30000` collect none of the Vitest fixture's test files.
- [ ] **No new CR literals.** No CR-shaped literal is added in `src/`, `public/` or `clients/`, the
      citation tripwire's pins are unchanged, and the citations already on rewritten lines are kept.

## How it is worked

Sandesh is told, when 0.4.0 ships, that it must declare `[bun] package_dir`. Model B hears of the
declared test script, `--name` and the passthrough fix in the 0.4.0 release notes, and that its
rendered bun agent definitions (and the skills) still name `integrations/pi` and "no test-name
filter".

## Non-goals

- Classifying a runner from a script's body. What runs is still the declaration, by name.
- A tier for a targeted run; only a tier verb states one.
- Coverage for a targeted run.
- Live progress narration of a Vitest run (its completion lines and a `--name`-aware pre-count).
- An install-level `[bun] package_dir`.
