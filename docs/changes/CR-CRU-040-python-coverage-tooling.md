# CR-CRU-040 — Patch: python-client coverage tooling (gate can't produce coverage)

**Status:** PENDING
**Type:** patch (tooling correctness)
**Priority:** P1 — the Python close-out gate cannot satisfy coverage-on-green
**Depends on:** CR-CRU-039 (the discovery fix — the suite must run before coverage can be measured)
**Labels:** patch, client, python, coverage, gate-correctness
**Phase:** Wave 4
**Design reference:** observed during the CR-CRU-039 close-out (2026-07-23) — the
orchestrator ran `regression` WITHOUT `--coverage` because the coverage path is broken;
the Python gate therefore reports no coverage.

## Context
With CR-CRU-039 the Python suite runs (376 tests), but the gate still cannot produce
coverage. Two independent breakages in the coverage path:
1. **`coverage` (coverage.py) is not available to the gate** — `regression --coverage`
   and `pre-merge-gate` invoke `python -m coverage run …`, but the project `.venv` has no
   `coverage` module (`No module named coverage`). It is not declared as a dev dependency
   anywhere the gate can rely on.
2. **`--cov-source` defaults to `app`** (`python-crucible.py:1410` regression, `:1440`
   pre-merge-gate), but there is **no `app/` package** in this repo — the Python source is
   `crucible_axi` + `clients`. Even with `coverage` installed, `--source app` measures a
   nonexistent package (0% / empty), so coverage-on-green is meaningless.

The orchestrator standard is "coverage ONLY on a full-green regression" — the Python gate
must be able to deliver that. This patch makes `regression --coverage` produce real,
correct coverage over this repo's Python source.

## Scope

### §S1 — `coverage` is available to the Python gate
Declare `coverage` (coverage.py) as a dev dependency the gate can depend on (e.g. a
`[project.optional-dependencies] dev` / dev extra in `pyproject.toml`, plus ensuring it is
installed into the project `.venv`), so `python -m coverage run …` resolves. Document the
one-time install in the RUNBOOK/README dev section if appropriate.

### §S2 — `--cov-source` measures this repo's real Python source
Fix the `--cov-source` default so coverage measures `crucible_axi` + `clients` (the actual
Python source), not the nonexistent `app`, for BOTH the `regression` and `pre-merge-gate`
argument defaults in the repo's vendored `clients/python-crucible.py`. (The client is
vendored per-repo; the repo copy is the source of truth. Prefer a correct, explicit default
for this repo over relying on every gate invocation to pass `--cov-source`.)

## Acceptance criteria
- [ ] `python-crucible.py regression --coverage --agent <x>` (default `--cov-source`)
      runs the full suite AND produces a **real** coverage figure over `crucible_axi` +
      `clients` (non-empty, > 0%), ingested green — asserted.
- [ ] `coverage` resolves in the project `.venv` (no `No module named coverage`).
- [ ] The orchestrator close-out gate fires coverage on a full-green Python regression
      (coverage-on-green satisfied).

## Non-goals
- The discovery / empty-guard fix (CR-CRU-039 — shipped).
- Any coverage THRESHOLD/enforcement gate, coverage-trend UI, or bun-side coverage
  changes — this is only about the Python gate being ABLE to produce correct coverage.
- Changing the generic (mirror) client's default beyond this repo's vendored copy.
