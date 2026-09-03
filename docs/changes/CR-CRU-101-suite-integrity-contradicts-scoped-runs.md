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

The primary guarantee (the `bunfig` assertions, which prove the runner is CONFIGURED to discover
every file) is unaffected and stays. It is also enough: CR-CRU-096 AC28a's e2e hole was a feature
that ran and FAILED, not a file that never ran, so the deleted junit comparison would not have
caught it either. The invisible-coverage worry is answered by config, not by run history.

## Scope

### §S1 — the corroboration is DELETED

**Amended 2026-09-04 by user ruling, and the amendment is the point of this CR.** §S1 originally
said the corroboration must state its own precondition, and an earlier AC6 forbade deleting it. Both
were the orchestrator's invention, not the problem's requirement, and together they cost ~900 lines
across four cycles: a client-written scope stamp, an artifact binding, three-case mtime arithmetic,
an anti-vacuity skip, a two-channel fixture with its own summary-line parser, and a filename drift
guard — all of it machinery to make one secondary check trustworthy.

What settled it was VERIFY's own measurement: **the corroboration can never conclude inside a client
run.** `_wipe` deletes the artifact and bun flushes its report only at process exit, so at collection
time the artifact does not exist and the check always skips. It concludes only in a bare `bun test`
issued by hand after a whole-suite client run — which is not a thing that happens in this project's
workflow. Every piece of the machinery above was defending a check that never fires.

So the junit comparison, and everything that existed only to license it, is removed: the check
itself, the scope stamp in `clients/bun-crucible.py`, and the client test that pinned the stamp. With
no prior-run artifact read at all, a run can no longer fail because of how the previous command was
invoked — which is the whole defect, closed by subtraction.

The primary guarantee is untouched and needs no run history: the `bunfig` assertions, which read
CONFIG. CR-CRU-047 §S1's reasoning already stands on its own — with no permanent exclusion possible,
on-disk/run parity holds BY CONSTRUCTION.

### §S2 — the structural guarantee is shown to be load-bearing

The one thing worth adding: proof that the `bunfig` assertion is not a tautology. A scratch fixture
where a `.test.ts` file sits behind a `pathIgnorePatterns` entry, showing that a real bun run misses
the file AND that the guard reports the entry; remove the entry and both observations flip.

That requires the guard's decision to be a pure function of config TEXT so it can be asked about the
fixture's config, while the two existing assertions keep reading the real `bunfig.toml`.

**Why not enumerate discovery on the real tree:** bun 1.3.14 has no discovery-listing or dry-run
flag (checked across `bun test --help`), so "enumerate what the runner would collect" over this repo
means actually running it — which restores the ~5.5-minute nested full-suite `Bun.spawn` that
CR-CRU-047 deliberately deleted, and that this file's own header explains at length. The fixture buys
the signal at fixture cost.

## Acceptance criteria

- **AC1** — No run can fail because a PREVIOUS run's artifact described a different set of files.
  Satisfied by there being no such read: nothing under `tests/` consults `test-reports/` to decide
  anything about the tree. Proven by the sequence that used to produce the failure — a scoped run,
  then a run containing the check.
- **AC2** — Nothing remains that skips, warns or explains itself about a stale artifact, because
  nothing reads one. A skip message about a file the suite no longer opens is dead prose.
- **AC3** — The `bunfig` discovery assertions keep their titles, still read the real `bunfig.toml`,
  and still fail if the runner is configured to miss a directory.
- **AC4** — The structural guarantee is shown load-bearing: a `.test.ts` behind a
  `pathIgnorePatterns` entry is missed by a REAL bun run and reported by the guard, both observed in
  a scratch fixture; removing the entry flips both. Observed, never asserted.
- **AC5** — `test-reports/` is not read anywhere under `tests/`, and `clients/bun-crucible.py` is
  byte-identical to its state on `develop`. The simplification is complete rather than partial: no
  stamp, no binding, no mtime arithmetic, no orphan client surface.
- **AC6** — RETRACTED 2026-09-04. It required the corroboration be repaired rather than deleted, and
  it was the orchestrator's invention. Deleting the check is the correct fix, and this AC was the
  reason four cycles were spent not doing it. Recorded rather than erased: a retracted AC is a
  finding about how this CR was specified.

## Non-goals

- **Keeping the junit corroboration.** See the retracted AC6 and §S1.
- **Making a bare `bun test` write the artifact.** Adding a `[test]` reporter section to
  `bunfig.toml` would refresh `junit.xml` on every invocation and mask the defect rather than fix it,
  and it would write a report file on every ad-hoc run.
- **Restoring a nested full-suite run.** CR-CRU-047 removed it on cost grounds that still hold.
- **The other stacks' clients.** `test-reports/junit.xml` is the bun stack's artifact; the python,
  java, arduino and vscode clients have their own report shapes and their own parity checks, and
  nothing here obliges them to record scope.
