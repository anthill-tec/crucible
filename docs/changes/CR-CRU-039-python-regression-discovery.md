# CR-CRU-039 — Patch: python-client `regression` discovers 0 tests (silent gate gap)

**Status:** PENDING
**Type:** patch (tooling correctness)
**Priority:** P1 — the Python close-out gate silently runs NOTHING
**Depends on:** CR-CRU-036 (§S9 client transition — the current `regression` shape)
**Labels:** patch, client, python, regression, gate-correctness, axi
**Phase:** Wave 4
**Design reference:** observed during the CR-CRU-009 close-out gate (2026-07-23) — the
orchestrator's Python regression reported "no JUnit XML produced — ingesting as compile"
instead of running the suite; the 374-test Python suite never executed in the gate.

## Context
`python-crucible.py regression` builds `python -m xmlrunner discover -s <start_dir>
-p <pattern>` with `--start-dir` defaulting to `tests`. Every Python test in this repo
lives under `tests/client/` (20 files, 374 tests). `tests/client/` has no `__init__.py`,
so `unittest discover -s tests` treats it as a non-package subdirectory and **does not
recurse into it** → **0 tests discovered**. With 0 tests, xmlrunner writes no
`TEST-*.xml`, so `_produced_xml` is false and the client falls into its
"no JUnit XML produced — ingesting captured output as **compile**" branch — masking a
zero-discovery as a compile problem and exiting non-zero.

Two distinct defects compound here:
1. The Python suite is undiscoverable from the client's default `start_dir` — so the
   regression gate runs nothing (confirmed: `discover -s tests` → 0; `discover -s
   tests/client` → 374).
2. A zero-test discovery is reported as a "compile" ingest, which HID the real cause and
   let a no-op gate slip by unnoticed until the CR-009 close-out.

## Scope

### §S1 — Make the Python suite discoverable from the default `start_dir`
Add `tests/__init__.py` and `tests/client/__init__.py` so `tests` is a package tree and
`unittest`/`xmlrunner discover -s tests -p 'test_*.py'` recurses into `tests/client/` and
finds all 374 tests. (Verified: with the two `__init__.py` files, `discover -s tests` →
`Ran 374 tests … OK`, no import breakage — the tests import top-level `crucible_axi` /
`clients` from cwd, unaffected by becoming a package.) This keeps the fleet client's
generic `--start-dir tests` default valid rather than hardcoding a repo-specific path
into the shared client.

### §S2 — A zero-test discovery is a DEFINITIVE AXI error, never a masked "compile"
Generic client-robustness fix (all projects): when a discovery run produces no
`TEST-*.xml` **because zero tests were collected** (as opposed to a genuine import/compile
failure), `regression` (and `test` on discovery) must emit a **definitive** TOON-AXI error
on stdout — a structured `warnings[]`/error entry `no-tests-discovered` naming the
`start_dir` + `pattern`, a `help[]` next-step (e.g. "check --start-dir / --pattern; ensure
the test dir is a package"), and a non-zero exit — rather than the misleading
"no JUnit XML produced — ingesting as compile" path. A real compile/import error (stderr
carries a traceback / collection error) still routes to the compile panel as today; only
the empty-discovery case gets the distinct, honest signal. (AXI axi.md: principle 5
definitive states, principle 6 structured-on-stdout, principle 9 help next-steps.)

## Acceptance criteria
- [ ] §S1: `python-crucible.py regression --agent <x>` with the DEFAULT `--start-dir`
      discovers and runs the full Python suite (374 tests) and ingests a real
      `regression` run — asserted (no more 0-test / "compile" fallback on the happy path).
- [ ] §S1: a targeted `test --tests <dotted.path>` run still works unchanged.
- [ ] §S2: a `regression` invoked with a `--start-dir`/`--pattern` that matches nothing
      emits a definitive `no-tests-discovered` AXI error (code + start_dir/pattern detail
      + `help[]`) on stdout and exits non-zero, and does **not** ingest a "compile" run —
      asserted, distinct from a genuine import-error (which still routes to compile).

## Non-goals
- Python **coverage** tooling: the `--cov-source` default `app` is wrong for this repo
  (source is `crucible_axi` + `clients`) and `.venv` lacks `coverage`/`pytest`. Real,
  but a SEPARATE follow-up — this patch is discovery + the empty-guard only, per the
  "small CR" scope. Noted here so it isn't lost.
- Any change to the bun/e2e gates or the `test`/`auto-ingest` happy paths beyond §S2's
  empty-discovery branch.
