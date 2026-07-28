# CR-CRU-045 — Patch: the `coverage/` shadow test over-specifies its contract

**Status:** PENDING
**Type:** patch (test correctness)
**Priority:** P2 — a red test on `develop`; the specified guarantee itself is intact
**Depends on:** CR-CRU-036 (owns the guarantee), CR-CRU-040 (surfaced the mismatch)
**Labels:** patch, test-correctness, python, coverage, cross-stack-gate
**Phase:** Wave 4
**Design reference:** CR-CRU-036's C4 contract — *"fix the `coverage/` directory shadow of
`python -m coverage` (dir on path shadows the module)"*, AC: *"coverage still collects when a
`coverage/` **dir** is present on the interpreter's path"*. Re-scoped by gap-analysis
(2026-07-28) — **Option A, user-decided**.

## Context
`tests/clients-python-arduino-crucible.test.ts` is red on `develop`:

> CR-CRU-036 C4: a `coverage/` directory present in project_dir does NOT shadow coverage.py
> collection

The first reading was that CR-CRU-040 regressed CR-036's guarantee by removing
`PYTHONSAFEPATH`. **Gap-analysis disproved that.** What CR-040 broke is the *test's* case,
which is stronger than the contract CR-036 specified.

**The real hazard is a bare directory.** `coverage/` is bun's lcov output directory — in this
repo it holds `lcov.info` plus temp files and has **no `__init__.py`**. That makes it a
*namespace* package, and a namespace package loses to a regular package regardless of
`sys.path` order.

**The test plants `coverage/__init__.py`**
(`tests/clients-python-arduino-crucible.test.ts:804`), making it a *regular* package, which
does win over site-packages when cwd is on the path.

Demonstrated empirically against the project interpreter:

| planted in cwd | `import coverage` resolves to |
|---|---|
| bare `coverage/` + `lcov.info` (the real shape) | `.venv/…/site-packages/coverage/__init__.py` — **real module wins** |
| `coverage/__init__.py` (the test's shape) | the local fake — **shadows** |

So CR-036's stated contract holds today **without** `PYTHONSAFEPATH`, and CR-040's inline
reasoning (`clients/python-crucible.py:611-615`, `:710-716`) is correct. CR-040's removal was
also independently justified: `PYTHONSAFEPATH` is an environment variable and therefore
inherits into grandchild test subprocesses, breaking their tmpdir-cwd dotted-name imports.

Restoring the test's stronger case would require dropping cwd from the direct child's
`sys.path` without an inherited env var. The clean mechanism is `python -P`, which is
**3.11+**, while `pyproject.toml:9` declares `requires-python = ">=3.10"` — so it would cost a
floor bump or version-conditional argv, to defend a scenario not shown to occur.

**Decision (user, 2026-07-28): align the test to the real hazard.**

## Scope

### §S1 — Align the test to CR-036's actual contract
Change the shadow test to plant a **bare** `coverage/` directory containing an lcov-like file
and **no `__init__.py`** — matching both bun's real output shape and CR-036's wording ("a
`coverage/` dir is present on the interpreter's path"). The test's existing assertions stay:
`regression --coverage` returns exit 0 and `event.coverage` reflects the real lcov figures.
This asserts the guarantee that genuinely matters and is genuinely held.

### §S2 — Record why the regular-package case is out of scope
Comment in the test (and in `clients/python-crucible.py` alongside the existing CR-040 notes)
stating: a `coverage/` directory carrying `__init__.py` is a *regular* package and WILL shadow
the real module while cwd is on `sys.path`; that is inherent to running `python -m coverage`
from a project whose tree contains a `coverage` package, is not specific to this client, and
would cost a 3.11 floor (`python -P`) to defend. Naming it prevents a future reader
"restoring" a guarantee that was never specified.

### §S3 — Cross-stack gate note
Record in the CR queue's Notes that a change to `clients/*-crucible.py` requires **both** the
Python gate and the bun gate before close-out: those clients are Python programs whose
observable contract is asserted by bun tests. CR-040 gated on Python only (382/0) and this red
test went unnoticed until the CR-041 C1 gate. That is the process lesson regardless of who was
right about the shadow.

## Acceptance criteria
- [ ] `tests/clients-python-arduino-crucible.test.ts` is fully green (28/28 in that file).
- [ ] The shadow test plants a **bare** `coverage/` dir (an lcov-like file, no `__init__.py`)
      and still asserts exit 0 plus real, non-empty `event.coverage` figures — i.e. the
      assertions were re-pointed, NOT weakened or deleted.
- [ ] The out-of-scope rationale from §S2 is present in the test and in the client, naming the
      regular-package case explicitly.
- [ ] `PYTHONSAFEPATH` is NOT reintroduced anywhere in `clients/` — asserted, since
      reintroducing it would re-break grandchild subprocess imports.
- [ ] Full bun regression green AND full Python regression green — both stacks, per §S3.

## Non-goals
- Reverting CR-CRU-040 or reintroducing `PYTHONSAFEPATH`. Its removal is correct on both
  counts: the real hazard is unaffected, and the env var leaked into grandchildren.
- Defending the regular-package case (`coverage/__init__.py` in the project tree) — explicitly
  out of scope per §S2; revisit only if a real project hits it.
- Raising `requires-python` to 3.11 for `python -P`.
- Changing `--cov-source`, coverage thresholds, or trend behaviour.

## Risk
- The obvious wrong fix is to weaken the test into passing (drop the coverage assertions, or
  stop invoking `--coverage`). §S1 requires the assertions be RE-POINTED, not relaxed — a
  reviewer should confirm exit-0 and non-empty coverage figures are still asserted.
- If a future change puts the project's own tree ahead of site-packages for other modules, the
  §S2 note is the breadcrumb explaining why this was accepted.
