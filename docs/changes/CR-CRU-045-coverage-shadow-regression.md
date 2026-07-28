# CR-CRU-045 — Patch: a `coverage/` directory in the project shadows coverage.py again (CR-040 regression)

**Status:** PENDING
**Type:** patch (regression — client correctness)
**Priority:** P1 — `regression --coverage` fails in any project containing a `coverage/` directory
**Depends on:** CR-CRU-040 (introduced the regression), CR-CRU-036 (owns the guarantee being restored)
**Labels:** patch, client, python, coverage, regression, gate-correctness, 0.1.0-blocker
**Phase:** Wave 4 (0.1.0 blocker)
**Design reference:** the CR-CRU-036 C4 guarantee — *"a `coverage/` directory present in
project_dir does NOT shadow coverage.py collection"*. Regression found by the CR-CRU-041 C1
orchestrator gate (2026-07-28).

## Context
`tests/clients-python-arduino-crucible.test.ts` fails on `develop`:

> CR-CRU-036 C4: a `coverage/` directory present in project_dir does NOT shadow coverage.py
> collection — event.coverage STILL reflects the fake lcov output

The test plants an inert `<project_dir>/coverage/__init__.py`, runs
`python-crucible.py regression --coverage` with cwd = project_dir, and asserts exit 0 with
real coverage. It now exits 1: the planted package shadows the real `coverage` module.

**Cause confirmed by bisect, not inference:**

| Tree | `PYTHONSAFEPATH` occurrences in `clients/python-crucible.py` | Result |
|---|---|---|
| `5b516e2^` (immediately before CR-040 merged) | 4 | **28 pass / 0 fail** |
| `develop` (after CR-040) | 0 | **27 pass / 1 fail** |

CR-CRU-040 §S1 removed `PYTHONSAFEPATH`, which had kept the subprocess's cwd off `sys.path`.
Its removal was deliberate and its stated reason is sound — the client's own comments record
it (`clients/python-crucible.py:611,710,713`): *"Setting PYTHONSAFEPATH would leak into
grandchild test [subprocesses]"*. Both concerns are real:

- **Keep the cwd off `sys.path`** → the planted `coverage/` cannot shadow the real module
  (CR-036 C4).
- **Do not set `PYTHONSAFEPATH` in the environment** → it is inherited by grandchild test
  subprocesses, changing import behaviour for the code under test (CR-040 §S1).

An env var cannot satisfy both, because env vars inherit. The fix must scope the path change
to the direct child only.

**Why it reached `develop`:** CR-040's close-out ran the **Python** gate (382/0). This
behaviour is Python-client code whose contract is asserted by a **bun** test, so only half the
evidence was gathered. This is the third consecutive defect in this lineage (039 zero
discovery → 040 unobtainable coverage → 045 coverage re-broken), each caught by the *next*
CR's gate rather than its own.

## Scope

### §S1 — Restore the no-shadow guarantee without an inherited env var
Prevent the project directory from shadowing real modules for the **direct** coverage/test
subprocess only, without exporting `PYTHONSAFEPATH` into its environment (which grandchildren
inherit). Any mechanism scoped to the direct child is acceptable — the constraint is that the
CR-036 C4 guarantee and the CR-040 §S1 no-leak requirement must BOTH hold simultaneously, and
each must have its own test.

### §S2 — Both guarantees become co-asserted, so neither can be traded away again
The suite must contain a test pair that fails if either property is lost: one asserting the
planted-`coverage/` case still collects real coverage, one asserting the direct child's import
behaviour does not leak into a grandchild test subprocess. Reference each other in comments so
a future change cannot satisfy one by silently breaking the other — which is precisely what
CR-040 did.

### §S3 — Cross-stack gate note for the client fleet
Record in the CR queue's Notes that a change to `clients/*-crucible.py` requires **both** the
Python gate and the bun gate before close-out: those clients are Python programs whose
observable contract is asserted by bun tests. A single-stack gate is insufficient evidence for
a client change.

## Acceptance criteria
- [ ] `tests/clients-python-arduino-crucible.test.ts` is fully green — the CR-036 C4
      shadow test passes (28/28 in that file).
- [ ] A test asserts `PYTHONSAFEPATH` is NOT present in the environment handed to grandchild
      test subprocesses (the CR-040 §S1 property) — asserted, not assumed.
- [ ] The two tests in §S2 exist and cross-reference each other.
- [ ] `regression --coverage` in a project containing `coverage/` returns exit 0 with real,
      non-empty coverage figures — the defect's end-to-end regression test.
- [ ] Full bun regression green AND full Python regression green — both stacks, per §S3.

## Non-goals
- Reverting CR-CRU-040. Its coverage-dependency and `--cov-source` fixes are correct and stay;
  only the shadowing side effect is in scope.
- Changing what `--cov-source` measures, or any coverage threshold/trend behaviour.
- The other clients' coverage paths, unless the same mechanism is demonstrably shared.

## Risk
- The two requirements are in genuine tension; a fix that satisfies one by weakening the
  other's test is a false green. §S2 exists specifically to make that impossible — reviewers
  should check that neither test was relaxed.
- `_collect_coverage` and `_regression_run` were made consistent by CR-040; whatever mechanism
  §S1 adopts must be applied to both, or they drift apart again.
