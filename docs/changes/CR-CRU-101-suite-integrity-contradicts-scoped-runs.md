# CR-CRU-101 — the suite-integrity corroboration contradicts scoped runs

- **Type**: bug
- **Wave**: 5 (0.2.0) — release membership is the user's call
- **Depends on**: none
- **Status**: PENDING (0.2.0) — filed 2026-09-03
- **Found by**: CR-CRU-097's full gate, then traced to the orchestration rule it conflicts with

## Problem

The corroborating parity check in `tests/suite-integrity.test.ts` (the third `describe`, *"On-disk vs
an existing junit artifact"*) asserts that the on-disk `tests/**/*.test.ts` file list equals the
distinct file list in `test-reports/junit.xml` **left behind by whatever run happened last**:

```ts
expect({ onDiskCount: onDisk.length, ranFiles }).toEqual({ onDiskCount: onDisk.length, ranFiles: onDisk });
```

Its premise — stated in its own skip message — is that the artifact comes from *"a prior real bun
run"*, meaning a **full** one. Nothing enforces that. Any scoped run overwrites `junit.xml` with a
subset, and **the next run that includes this check then fails**, reporting a difference that
describes **how the previous command was invoked** rather than anything about the tree.

**Reproduced on clean `develop` at `bdeddca`, 2026-09-03:** the artifact on disk held **1** distinct
file (`tests/boot-safety.test.ts`) against **145** on-disk `.test.ts` files, and
`bun test tests/suite-integrity.test.ts` failed 1 of 4 on exactly that comparison. No code defect
existed; the previous command had simply been narrower than the tree.

**Who writes the artifact — measured, because the first filing of this CR guessed.** `bunfig.toml`
carries **no `[test]` section at all**, so a bare `bun test` writes NOTHING to `test-reports/`: the
JUnit reporter is enabled only by `clients/bun-crucible.py`'s `_bun_test_cmd`, which appends
`--reporter=junit --reporter-outfile=…`, and `_wipe` deletes the previous artifact first. Verified by
running `bun test tests/boot-safety.test.ts` directly and observing `junit.xml`'s size and mtime
unchanged to the nanosecond.

Two consequences the fix depends on:

1. **"A full run" must mean a full CLIENT run.** A full bare `bun test` gate does not refresh the
   artifact, so it reads whatever the last client run left and fails on the same stale comparison.
   The defect is not "invisible whenever the whole suite runs" — it is invisible only when the whole
   suite runs THROUGH THE CLIENT, which is what wipes and rewrites the artifact before the check
   reads it.
2. **The scope is known exactly where the artifact is produced.** `_bun_test_cmd(bun, targets, …)`
   receives `targets` — empty for a whole-suite run, a file list for a scoped one. Whatever proves
   fullness must come from there; it cannot be recovered downstream.

So the failure lands on any run whose own scope is narrower than the tree, which is every run the
orchestration discipline asks for.

## Why this is structural, not bad luck

The project's own sub-agent discipline requires scoped runs. Every dispatch brief in this repo says
*"run ONLY the suites you touch — do NOT run the project-wide gate, the orchestrator owns it"*, and
that rule exists for good reasons: it keeps agents off each other's mid-flight edits and keeps a
cycle's ingest attributable. CR-CRU-097 ran nine such scoped runs across four cycles.

So the rule and the test are in **direct conflict**: following the orchestration discipline
guarantees this assertion fails afterwards. It is not detecting a defect; it is detecting
compliance.

It is also the third instance of the family CR-CRU-100 names and CR-CRU-097 §S3 diagnoses: **a
contract asserted over mutable local state**. There the state was the live dog-food database and our
own backlog; here it is the last run's report artifact. In each case the assertion was true when
written and decays through ordinary use, and in each case it fails without naming a code defect.

## What is worth keeping

The intent is real and worth preserving: a test file that exists on disk but never runs is invisible
coverage, and this project has been bitten by exactly that — **CR-CRU-096 AC28a** records an e2e
feature (`tests/e2e/features/roadmap-graph.feature`) that **had never passed** because
`handleQueuePost` never read `fields.release`, while ACs cited it as corroboration. (The first
filing of this CR attributed that AC to CR-CRU-099, which is the CR that FIXED the route, not the
one that recorded the hole.)

The primary guarantee (the `bunfig` assertion, which proves the runner is configured to discover
every file) is unaffected and stays. Only the corroboration half is defective.

## Scope

### §S1 — the corroboration states its own precondition

The check runs only against an artifact it can prove came from a **full** run. Absent that proof it
SKIPS with the reason named, exactly as it already does when the artifact is missing. A skip that
says why is honest; a failure that describes the previous command is not.

**Where the proof comes from, since the gap analysis settled it:** the producing client, which knows
its own scope at the moment it builds the invocation. This CR therefore changes
`clients/bun-crucible.py` as well as the test — a shipped client surface, named here rather than
discovered mid-implementation.

**One option is REJECTED, and the rejection is the point.** "Infer fullness from the artifact
itself" cannot work: bun's JUnit output records test counts, not a file total and not how it was
invoked, so the only artifact-internal proxy for "this was full" is *"its file set equals the
on-disk set"* — which is the check's own conclusion. A precondition identical to the conclusion
yields a test that can never fail, satisfying AC5 vacuously while detecting nothing.

### §S2 — invisible coverage keeps a detector that cannot decay

The "a file on disk never ran" question is answered without depending on run history, and the
guarantee on the real tree stays STRUCTURAL — the `bunfig` assertion, which holds under any
invocation because it reads config rather than history.

What is added is proof that the structural assertion is **load-bearing**, which today is asserted
and never demonstrated: a scratch fixture in which a `.test.ts` file exists that the runner's
discovery does not reach, showing the guard fires on it. The fixture machinery already exists in
this file for the `regression` envelope check — two files, real spawn, milliseconds.

**Why not enumerate discovery on the real tree:** bun 1.3.14 has no discovery-listing or dry-run
flag (checked across `bun test --help`), so "enumerate what the runner would collect" over this repo
means actually running it — which restores the ~5.5-minute nested full-suite `Bun.spawn` that
CR-CRU-047 deliberately deleted, and that this file's own header explains at length. The fixture buys
the same signal at fixture cost.

## Acceptance criteria

- **AC1** — A run that includes this check never fails because a PREVIOUS run's artifact described a
  different set of files. Proven against the sequence that produces it — a scoped run, then a run
  containing the check — rather than against a full run through the client, which masks it by
  rewriting the artifact first (see the measurement in the Problem statement).
- **AC2** — With a genuinely stale-or-partial artifact, the corroboration SKIPS and names the
  reason; it never fails.
- **AC3** — §S1's `bunfig` discovery assertion is untouched and still fails if the runner is
  configured to miss a directory.
- **AC4** — §S2's detector fails when a `.test.ts` file exists that the runner's discovery does not
  reach, proven by adding such a file in a scratch fixture rather than by assertion.
- **AC5** — The check does not read `test-reports/` as a source of truth about the tree. Any
  reference to a prior run's artifact is corroboration only, and its precondition is asserted before
  its conclusion.
- **AC6** — The corroboration is REPAIRED, not deleted. A change that removes the junit comparison
  outright satisfies AC1 trivially and is not this CR: AC2 and AC5 presuppose the check still exists
  and still concludes something when its precondition holds.

## Non-goals

- **Deleting the junit corroboration.** See AC6.
- **Making a bare `bun test` write the artifact.** Adding a `[test]` reporter section to
  `bunfig.toml` would refresh `junit.xml` on every invocation and mask the defect rather than fix it,
  and it would write a report file on every ad-hoc run.
- **Restoring a nested full-suite run.** CR-CRU-047 removed it on cost grounds that still hold.
- **The other stacks' clients.** `test-reports/junit.xml` is the bun stack's artifact; the python,
  java, arduino and vscode clients have their own report shapes and their own parity checks, and
  nothing here obliges them to record scope.
