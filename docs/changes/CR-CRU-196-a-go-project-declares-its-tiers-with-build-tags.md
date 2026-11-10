# CR-CRU-196 — a Go project declares its tiers with build tags

**Type** feature · **Points** 8 · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-195 · **Status**
PENDING — filed 2026-10-18 (Model B request, user ruling: Go's tiers are declared by build tag);
made exact at gap analysis 2026-11-10 (user rulings 2026-11-10: one run per tier, a tier runs only
the tests its tag adds, `regression` covers every declared tier) · Pre-review: due — 8 points and
user rulings

## Problem

Raised by Model B (2026-10-18) with the Go client, CR-CRU-195. Every client declares a run's tier,
and each stack declares its tier targets in its own native place: bun in `package.json` scripts,
rust in nextest profiles, maven in `pom.xml` profiles. Go has no script table. In Go, an
integration tier is usually a build tag (`//go:build integration`), and the project's own services
bring up the backends that tier needs.

The Go client CR-CRU-195 shipped has no tier verbs, and its gate refuses every `--suites`.

## Design

Settled with the user on 2026-10-18; made exact on 2026-11-10.

- **A tier is a build tag of the same name.** A module declares tier `<tier>` when the tag brings
  in a test file the untagged build does not. Go judges this itself:
  `go list -tags <tier> -f '{{.TestGoFiles}} {{.XTestGoFiles}}' ./...` names a file that the same
  `go list` without the tag does not. A text scan of `//go:build` lines is not used, because it
  cannot evaluate an expression such as `integration && linux`.
- **A tier runs only the tests its tag adds (user ruling 2026-11-10).** Measured on go 1.27.3:
  `go test -tags integration` also runs every untagged test, and drops every
  `//go:build !integration` test. So a tier's tests are, per package, the names
  `go test -list . -tags <tier>` prints minus the names the same list prints without the tag. Each
  such package runs as `go test -json -tags <tier> -run '^(<names>)$' <package>`, and every package
  of every declaring module goes into the one run, filed under tier `<tier>`. Its start total is
  the size of that set. An `integration` run never files a unit test.
- **The gate runs each declared tier as a run of its own (user ruling 2026-11-10).** The gate's
  untagged run is one declared suite, named `untagged`. Each declared tier is another, with its own
  run, counts and outcome, so `--suites integration` re-gates that tier alone. `e2e` is listed and
  excluded from the gate, as on every stack. The shared composition runs an own-stack suite that the
  whole run does not collect as a suite of its own. Go marks the tier suites that way and the
  `untagged` suite not, so the untagged run is never skipped. The shared module does not change.
- **`regression` is every declared tier (user ruling 2026-11-10).** One run holds the untagged
  tests of every module plus each declared tier's tests, `e2e` included. The sets do not overlap,
  so no test runs twice.

## Scope

### §S1 — the declaration surface and the tier verbs

The Go client gains `unit`, `module`, `integration`, `e2e` and `bdd`. They are registered through
the shared `add_tier_verbs` with a Go `DeclaredTierSurface`, whose `read`, `run` and `suites` all
apply the one declaration rule above.

- **Which modules a tier verb runs.** Every module under the project dir that declares the tier,
  found as `regression` finds modules. `--module-dir` narrows it to one module.
- **The order of refusals.** Before any test runs and before anything is filed:
  1. an unattributed run;
  2. a Go below the floor;
  3. no module;
  4. a board that does not decode `go-test`;
  5. a tier no module declares. This goes through the shared `TierRunUndeclared`, and its help
     names the declaration: `//go:build <tier>` in a `_test.go` file;
  6. a declared tier whose tag adds no test name, refused as an unmatched `--run` already is.
- **The run.** It is filed under the verb's tier. It carries `--agent`, `--cycle`, `--release`,
  `--module-dir`, `--reports` and `--log`, as `regression` does.

`check --tests` (CR-CRU-239) also compiles every declared tier's test files under that tier's tag,
in every module it checks. A tagged test file that does not compile fails `check --tests`, and its
errors are filed with the rest (added 2026-11-09 at CR-CRU-239's pre-review, finding F11).

### §S2 — the gate covers every declared tier

`pre-merge-gate` enumerates the declared suites, `untagged` and each declared tier, and runs each
as its own run through the shared composition. Each is one row of the gate's `suites[]`, with its
own counts and outcome, and each is recorded in the gate milestone. `e2e` is a row marked excluded.
`--suites <targets>` runs only the named suites. A target Go does not declare is refused before
anything runs, by the shared scoped-gate check. A project that declares no tier keeps today's gate
of one untagged run.

### §S3 — `regression` covers every declared tier

`regression` runs, into ONE run, the untagged tests of every module and then each declared tier's
tests (§Design). With `--coverage`, every invocation's profile is sent with the run's close; a
missing one gives the existing `coverage-not-measured` warning.

### §S4 — help and docs

The Go client's help, module docstring, README, RUNBOOK and CHANGELOG name the tier verbs, the
declaration rule and the gate's per-tier rows. Code and help that say Go declares no tier are
removed.

## Acceptance criteria

- [ ] **AC1 — a tag declares a tier, and the tier runs only its own tests.** Take a real module
      with untagged `TestUnit`, `integration`-tagged `TestInteg` and `!integration`-tagged
      `TestNotInteg`. `integration --agent <id>` opens one run under tier `integration` with total
      1, and it files exactly `TestInteg`. Neither `TestUnit` nor `TestNotInteg` is in it.
- [ ] **AC2 — an undeclared tier is refused before anything runs.** With no `e2e`-tagged test
      file, `e2e --agent <id>` exits non-zero with `ok: false`, and its help names
      `//go:build e2e` in a `_test.go` file. No run is opened and no `go test` runs.
- [ ] **AC3 — the gate runs each declared tier as its own suite.** On the AC1 module plus a `bdd`
      tag and an `e2e` tag, `pre-merge-gate` gives these `suites[]` rows:
  - `untagged`: its own run, `TestUnit` and `TestNotInteg`;
  - `integration`: its own run, `TestInteg`;
  - `bdd`: its own run;
  - `e2e`: excluded.

  Each gated row has its own counts and outcome, and the gate milestone records each one. A
  failing `integration` test makes only that row fail.
- [ ] **AC4 — a scoped gate runs only the named tier.** `pre-merge-gate --suites integration`
      opens only the `integration` run, and the milestone records the scope as scoped.
      `--suites nosuch` is refused before anything runs.
- [ ] **AC5 — `regression` is every declared tier.** On the AC3 module, `regression` opens ONE run
      holding `TestUnit`, `TestNotInteg`, `TestInteg` and the `bdd` and `e2e` tests, each once. Its
      start total is their count.
- [ ] **AC6 — `check --tests` compiles every declared tier.** A compile error in an
      `integration`-tagged test file fails `check --tests`, and that error is filed with format
      `go`. The same module without the tagged error passes.
- [ ] **AC7 — every call site.** The client's parser offers `unit`, `module`, `integration`, `e2e`
      and `bdd`. Each verb is refused while a cycle is active elsewhere, before the toolchain is
      touched, and each appears in the fleet censuses the other clients' tier verbs are in.
- [ ] **AC8 — the docs follow.** The help, README, RUNBOOK and CHANGELOG name the tier verbs, the
      declaration rule and the gate's per-tier rows. Nothing says Go declares no tier.

## Non-goals

- Bringing up a tier's backends. That is the project's own services.
- `--coverage` on a tier verb or in the gate.
- A tier declared any other way than by build tag.
