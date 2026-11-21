# CR-CRU-196 — a Go project declares its tiers with build tags

**Type** feature · **Points** 13 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-195 · **Status**
DONE — merged 2026-11-10 (`ba5e56c7`) · Pre-review: ran — 8 points and user rulings (findings
F1–F14, all folded)

## Problem

Raised by Model B (2026-10-18) with the Go client, CR-CRU-195. Every client declares a run's tier,
and each stack declares its tier targets in its own native place: bun in `package.json` scripts,
rust in nextest profiles, maven in `pom.xml` profiles. Go has no script table. In Go, an
integration tier is usually a build tag (`//go:build integration`), and the project's own services
bring up the backends that tier needs.

The Go client CR-CRU-195 shipped has no tier verbs, its gate refuses every `--suites`, and its runs
carry no tier, so the board stores them as `unit`.

## Design

Settled with the user on 2026-10-18; made exact on 2026-11-10.

Measured on go 1.27.3: `go test -tags integration` runs every untagged test as well as the tagged
ones, and drops every `//go:build !integration` test. `go test -list` runs the test binary (and its
`TestMain`), lists nothing for a package that does not compile, and lists benchmarks.

### A tier's files and tests

- **Its files.** For tier `<tier>`, a package's tier files are the test files
  `go list -tags <tier> -f '{{.TestGoFiles}} {{.XTestGoFiles}}' ./...` names and the same
  `go list` without the tag does not. Go evaluates the constraint itself, so
  `integration && linux` is judged as Go judges it.
- **Its tests.** A tier's tests are the top-level test functions declared in its files, read from
  the source:
  - `Test*`, `Fuzz*`, and `Example*` with an output comment, as `go test` counts them;
  - never benchmarks, never `TestMain`.

  The names come from the source, not from `go test -list`. So a tier file that does not compile
  still has its tests, and its build failure reaches the run.
- **A module declares the tier** when its tier files declare at least one test. A tag that adds
  only helpers, a `TestMain` or non-test files declares nothing.
- **A name that cannot be separated is refused.** A tier test whose name is also declared in a test
  file that both builds compile, in the same package dir (internal or external test package), cannot
  be selected without the untagged one. Measured: `-run '^(TestY)$'` runs both. Such a tier is
  refused before anything runs, naming the package and the test.
- **A name in a `!<tier>` file is no clash.** That file is not compiled under the tag.

### What a tier runs (user ruling 2026-11-10)

A tier runs only its tests, so an `integration` run never files a unit test.

- **The invocations.** Every package with a tier file is invoked as
  `go test -json -tags <tier> -run '^(<names>)$' <package>`, in its module.
  - A package whose tier files declare no test runs with `-run '^$'`, so its build is still
    checked.
  - A package's names are split across several invocations so that no `-run` argument exceeds a
    byte budget well under Linux's 128 KiB per-argument limit.
  - Every invocation of every declaring module goes into the one run.
- **The run.** It is filed under tier `<tier>`, and its start total is the number of its tests.

### The gate runs each declared tier as a run of its own (user ruling 2026-11-10)

- **The suites.** When a module declares a tier, the gate's declared suites are:
  - `untagged`: the untagged `go test -json ./...` of every module, which is the gate's whole run;
  - one suite per declared tier.
- **No tier declared.** A project that declares no tier has no declared suites. Its gate is today's
  single untagged run, and every `--suites` is refused, as today.
- **How each suite runs.** Through the shared composition, unchanged:
  - `untagged` is the whole run, and its row is covered by it;
  - each tier is an own-stack suite the whole run does not collect, so it runs as a suite of its
    own, with its own run, counts and outcome;
  - `e2e` is listed and excluded, as on every stack.
- **What the gate's whole run is.** It is the untagged run only. The widened `regression` below is
  never the gate's whole run.

### Tiers stated on every run

- **The gate's untagged run** is filed under tier `regression` (user ruling 2026-11-10), as every
  stack's gate whole run is. On Go it holds only the untagged tests, and the gate's per-tier rows
  beside it complete the union. The testing-tiers DN records this.
- **A tier verb's run** is filed under its tier.
- **`regression`** is filed under `regression`.
- **`test`** is unchanged (no tier stated).

### `regression` is every declared tier (user ruling 2026-11-10)

ONE run, filed under `regression`, holding:

1. the untagged tests of every module;
2. then each declared tier's tests, `e2e` included, invoked as above.

No test is in two of these sets, so none runs twice.

## Scope

### §S1 — the declaration surface and the tier verbs

The Go client gains `unit`, `module`, `integration`, `e2e` and `bdd`. `regression` moves onto the
same shared registration (`add_tier_verbs`) as a wired verb that keeps its flags: `--agent`,
`--cycle`, `--release`, `--reports`, `--log`, `--project-dir` and `--coverage`.
`pre-merge-gate` stays where it is.

**The Go `DeclaredTierSurface`.** Its `read`, `run` and `suites` apply the one rule above.

- **`read` performs the refusals the shared path cannot.** It raises the shared hard-stop
  exceptions `run_verb` already maps, so no shared change is needed:
  1. an unattributed run;
  2. no Go, or a Go below the floor;
  3. no module.

  Then it probes the declaration. `go list` runs; no `go test` does.
- **`run` checks first:**
  1. a board that does not decode `go-test`;
  2. a name that cannot be separated.

  Then it runs.
- **A tier no module declares** raises the shared `TierRunUndeclared`, and its help names the
  declaration: `//go:build <tier>` in a `_test.go` file that declares a test.

**Which modules a tier verb runs.** Every module under the project dir that declares the tier,
found as `regression` finds modules.

- `--module-dir`, new on the tier verbs, narrows the run to that one module. A module that does
  not declare the tier is refused as undeclared.
- `GO_CRUCIBLE_MODULE_DIR` and `crucible.toml [go] module_dir` do not narrow a tier verb, as they
  do not narrow `regression`.

The tier verbs carry `--agent`, `--cycle`, `--release`, `--module-dir`, `--reports` and `--log`.

**`check --tests`** (CR-CRU-239) also compiles each declared tier's test files under that tier's
tag, in every module it checks (finding F11 of CR-CRU-239's pre-review).

- Every compile runs, even after an earlier one fails.
- Their output is filed as ONE compile run.
- A diagnostic line an earlier compile already reported is dropped, so an untagged error is filed
  once.

### §S2 — the gate covers every declared tier

`pre-merge-gate` composes the declared suites through the shared `gate_regression`, as described in
the Design.

- **The whole run** is the untagged run (`whole_suite` and `whole_suite_alone`), filed under
  `regression`.
- **The `suites` reader** raises the toolchain and no-module causes as the shared hard stop. It
  does not answer "declares no suites" for them.
- **A scoped gate:** `--suites <targets>` runs only the named suites, and a target Go does not
  declare is refused before anything runs.

### §S3 — `regression` covers every declared tier

`regression` is the one run described in the Design, filed under `regression`.

With `--coverage`, the client merges every invocation's coverprofile into ONE `go-coverprofile`
before the close:

- a block counts as covered when any invocation covered it;
- the `mode:` line is written once.

So a package profiled by its untagged run and again by its tier runs is counted once, at the union.
A missing profile gives the existing `coverage-not-measured` warning, as today.

### §S4 — help and docs

- **Help and docs.** The Go client's help, module docstring, README, RUNBOOK and CHANGELOG name:
  the tier verbs, the declaration rule, the refused name clash, the gate's per-tier rows, and the
  tier each run is filed under.
- **Removals.** Code and help that say Go declares no tier are removed.
- **The DN.** The testing-tiers DN (`docs/research/DN-testing-tiers-in-crucible-projects.md`) gains
  a Go note: the gate's whole run is untagged-only, and the gate's tier rows make the union.

## Acceptance criteria

All on real Go modules (go 1.27.3).

- [x] **AC1 — a tier runs only its own tests.**
  - **Setup:** a module with untagged `TestUnit`, `integration`-tagged `TestInteg` and
    `!integration`-tagged `TestNotInteg`.
  - `integration --agent <id>` opens one run under tier `integration` with start total 1, and it
    files exactly `TestInteg`.
  - **A shared name:** in a package where `TestX` is declared in a `!integration` file and again,
    failing, in an `integration` file, the `integration` run files that tagged `TestX` as failed.
- [x] **AC2 — an undeclared tier is refused before any test runs.**
  - With no `e2e` tier file, `e2e --agent <id>` exits non-zero with `ok: false`. Its help names
    `//go:build e2e` in a `_test.go` file, no run is opened, and no `go test` runs.
  - The same holds when the `e2e` tag adds only a helper file or a `TestMain`.
  - A benchmark-only tag file declares nothing.
- [x] **AC3 — a name that cannot be separated is refused.**
  - **Setup:** a package with untagged `TestY` in its internal test package and an
    `integration`-tagged `TestY` in its external one.
  - `integration` is refused before any test runs, naming the package and `TestY`.
- [x] **AC4 — a tier file that does not compile fails its run.**
  - An `integration` file with a type error makes the `integration` run fail with the build
    failure filed.
  - It is not refused, and it does not pass.
  - The same holds when that package's tier files declare no test.
- [x] **AC5 — the gate runs each declared tier as its own suite.** On the AC1 module plus a `bdd`
      tag and an `e2e` tag, `pre-merge-gate` gives these `suites[]` rows:
  - `untagged`: covered by the whole go suite, total 2. Its run is filed under `regression` and
    holds `TestUnit` and `TestNotInteg`.
  - `integration`: `client: go-crucible.py`, its own counts and outcome, and its run is filed under
    `integration`.
  - `bdd`: the same shape, filed under `bdd`.
  - `e2e`: excluded.

  The gate milestone records a result under each gated target. A failing `integration` test fails
  only that row.
- [x] **AC6 — scoped gates, refusals and the no-tier project.**
  - **On the AC5 module:**
    - `--suites integration` opens only the `integration` run, and the milestone's scope is
      scoped;
    - `--suites nosuch` is refused before anything runs;
    - with no `go` on PATH, `--suites integration` is refused, naming the toolchain, with an
      `ok: false` envelope and no traceback.
  - **On a module that declares no tier:**
    - the gate's envelope is today's, a single untagged run filed under `regression`;
    - `--suites untagged` is refused.
- [x] **AC7 — `regression` is every declared tier.**
  - On the AC5 module, `regression` opens ONE run under tier `regression`. It holds `TestUnit`,
    `TestNotInteg`, `TestInteg` and the `bdd` and `e2e` tests, each once, and its start total is
    their count.
  - With `--coverage`, a package whose untagged and `integration` runs cover different statements
    is stored with the union of the two.
- [x] **AC8 — `check --tests` compiles every declared tier.**
  - A compile error in an `integration`-tagged test file fails `check --tests` and is filed with
    format `go`.
  - An untagged compile error is filed once, however many tiers are declared.
  - The module without either error passes.
- [x] **AC9 — a tier with many tests is split, not refused.**
  - **Setup:** a package with 3000 `integration` tests, whose one `-run` would exceed Linux's
    128 KiB argument limit.
  - Its `integration` run runs them all in one run, with start total 3000 and 3000 filed.
- [x] **AC10 — modules.**
  - **Setup:** a project of two modules, where only `b` declares `integration`.
  - `integration` runs `b` only.
  - `integration --module-dir a` is refused as undeclared.
  - `regression` holds both modules' untagged tests and `b`'s `integration` tests.
- [x] **AC11 — every call site.**
  - The client's parser offers `unit`, `module`, `integration`, `e2e`, `bdd` and `regression`
    through the shared registration.
  - Each is refused while a cycle is active elsewhere, before the toolchain is touched.
  - Each appears in the fleet censuses that hold the other clients' tier verbs.
- [x] **AC12 — the docs follow.**
  - The help, README, RUNBOOK and CHANGELOG name the tier verbs, the declaration rule, the refused
    name clash, the gate's per-tier rows, and each run's tier.
  - The testing-tiers DN has the Go note.
  - Nothing says Go declares no tier.

## Non-goals

- Bringing up a tier's backends. That is the project's own services.
- `--coverage` on a tier verb or in the gate.
- A tier declared any other way than by build tag.
- A tier stated on `test`.

**Done 2026-11-10.** Merged `ba5e56c7` (plan 245: U1 903, U2 904, U3 905, VERIFY 906 APPROVE,
FIX 907 for S1, S2 and Sug1–Sug3). A Go module declares a tier with a `//go:build <tier>` test file
that declares a test; the tier verb runs only the tests that tag adds, as one run under the tier,
split under the per-argument budget, and refuses a name it cannot separate. The gate runs an
`untagged` suite, filed as `regression`, plus one suite per declared tier, with `e2e` excluded; a
project with no tier keeps today's gate. `regression` is one run of every tier and sends one merged
coverprofile. `check --tests` compiles each declared tier and files each error once. Go's declared
`unit` run carries the fleet's wall-vs-CPU warning. A module whose `go.mod` `go list` rejects has
`regression` and the gate refused, not run red. Sug4 (the tier-verb help is set through argparse's
private choice actions) is left for a shared help hook. Full gate: bun 5106/0, python 7522/0.
