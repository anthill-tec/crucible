# CR-CRU-101 — the suite-integrity corroboration contradicts scoped runs

- **Type**: bug
- **Wave**: 5 (0.2.0) — release membership is the user's call
- **Depends on**: none
- **Status**: PENDING (0.2.0) — filed 2026-09-03
- **Found by**: CR-CRU-097's full gate, then traced to the orchestration rule it conflicts with

## Problem

`tests/suite-integrity.test.ts:235-255` asserts that the on-disk `tests/**/*.test.ts` file list
equals the distinct file list in `test-reports/junit.xml` **left behind by whatever bun run happened
last**:

```ts
expect({ onDiskCount: onDisk.length, ranFiles }).toEqual({ onDiskCount: onDisk.length, ranFiles: onDisk });
```

Its premise — stated in its own skip message — is that the artifact comes from *"a prior real bun
run"*, meaning a **full** one. Nothing enforces that. Any scoped run overwrites `junit.xml` with a
subset, and **the next run that includes this check then fails**, reporting a difference that
describes **how the previous command was invoked** rather than anything about the tree.

**Measured 2026-09-03, because the filing had this backwards.** The failure does NOT land on the
next full gate: a full run rewrites `junit.xml` with every file before the check reads it, so it
passes — which is why `develop` is green immediately after a day of scoped runs. It lands on any
run whose own scope is narrower than the tree. A scoped client run leaving an artifact of two
classnames, followed by `bun test tests/suite-integrity.test.ts`, fails; the full gate over the same
tree passes. So the defect is invisible exactly when the whole suite runs, and fires exactly when
the orchestration discipline is followed.

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
coverage, and this project has been bitten by exactly that — CR-CRU-099 AC28a records an e2e feature
that **had never passed** because no gate ran it, while ACs cited it as corroboration.

The primary guarantee (§S1's `bunfig` assertion, which proves the runner is configured to discover
every file) is unaffected and stays. Only the corroboration half is defective.

## Scope

### §S1 — the corroboration states its own precondition

The check runs only against an artifact it can prove is a **full** run — e.g. one carrying a
recorded total file count, or a marker the full-gate invocation writes and a scoped run does not.
Absent that proof it SKIPS with the reason named, exactly as it already does when the artifact is
missing. A skip that says why is honest; a failure that describes the previous command is not.

### §S2 — invisible coverage keeps a detector that cannot decay

The "a file on disk never ran" question is answered without depending on run history: the runner's
own discovery is enumerated and compared against the on-disk list. That is a property of the tree
and the config, so it holds under any invocation.

## Acceptance criteria

- **AC1** — A run that includes this check never fails because a PREVIOUS run's artifact described a
  different set of files. Proven against the sequence that produces it — a scoped run, then a run
  containing the check — rather than against the full gate, which masks it (see the measurement in
  the Problem statement).
- **AC2** — With a genuinely stale-or-partial artifact, the corroboration SKIPS and names the
  reason; it never fails.
- **AC3** — §S1's `bunfig` discovery assertion is untouched and still fails if the runner is
  configured to miss a directory.
- **AC4** — §S2's detector fails when a `.test.ts` file exists that the runner's discovery does not
  reach, proven by adding such a file in a scratch fixture rather than by assertion.
- **AC5** — The check does not read `test-reports/` as a source of truth about the tree. Any
  reference to a prior run's artifact is corroboration only, and its precondition is asserted before
  its conclusion.
