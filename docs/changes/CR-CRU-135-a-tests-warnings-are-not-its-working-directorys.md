# CR-CRU-135 — a test's warnings are not its working directory's

**Type** fix · **Wave** 6 (0.2.0) · **Depends on** CR-CRU-030, CR-CRU-131 · **Status** PENDING

## Problem

`tests/client/test_crucible_axi_shared.py` and `tests/client/test_cr046_official_toon_roundtrip.py`
call `_crucible_axi.emit_axi(...)` directly and assert on the `warnings[]` the caller supplied
(`[]`, or one explicit entry), without ever calling `bind_project_dir()` first.

`emit_axi` (CR-CRU-131 §S1b, `clients/_crucible_axi.py:570-581`) deliberately appends
`limit_disclosure_warnings()` AFTER whatever the caller passed — by design, so no verb of any
client can silently omit a limit disclosure it owes its operator. `limit_disclosure_warnings()`
resolves `project_config_path()`, which is `_PROJECT_DIR` (a module-level global, `None` until
`bind_project_dir()` is called) or `os.getcwd()`.

Measured 2026-09-16: on a developer machine carrying a leftover root `crucible.toml` (gitignored,
so it is developer-local state, not repo state), `os.getcwd()` resolves a valid file and
`limit_disclosure_warnings()` returns `[]` — the tests pass by accident. On CI's fresh clone
(`/home/runner/work/crucible/crucible`, no root `crucible.toml`), the same call returns
`[{"code": "limit-configuration", "detail": "... no readable configuration ..."}]`, and four
tests across the two files fail asserting an exact `warnings` list that no longer matches.
Reproduced locally by moving the root file aside — identical failure to CI's.

## Why it matters

CI on `release/0.2.0` has been red on `test-python` since before this session (confirmed: the
same job failed on `develop` 7+ days ago, though with a different failure signature — the count
of affected tests has grown as more emit_axi-driving tests were added). The tests are not wrong
about the CONTRACT (CR-131's disclosure-on-every-exit rule is correct and desired); they are
missing the isolation `tests/client/test_client_limits_resolve_from_configuration.py` already
uses correctly (`setUp` binds a fresh tempdir via `bind_project_dir` so no test's outcome depends
on the ambient working directory's contents).

## Scope

### §S1 The four affected tests bind an isolated project dir

Each test in `SharedAxiEmitEnvelopeTest` (test_crucible_axi_shared.py) and
`ClientEmitSelfRoundTripThroughRealSeamTest` (test_cr046_official_toon_roundtrip.py) that drives
`emit_axi` binds a fresh tempdir (containing a minimal valid `crucible.toml`, or none at all if a
missing project file is itself meant to run `resolve_limit` at its shipped defaults with no
disclosure — either is enough to make `limit_disclosure_warnings()` return `[]` deterministically)
via `bind_project_dir()`, exactly as the existing isolated pattern does, before calling `emit_axi`.
No test's outcome may depend on `os.getcwd()`'s ambient contents.

## Acceptance criteria

- [ ] All four currently-failing tests pass identically whether or not a `crucible.toml` exists at
      the repo root — asserted by running the suite both with and without one present.
- [ ] No existing assertion is weakened: each test still asserts the exact `warnings` shape it did
      before, now genuinely proven rather than accidentally true.
- [ ] No production code (`clients/_crucible_axi.py`) is touched — CR-131's disclosure-on-every-exit
      design is correct; only the tests' isolation is fixed.
- [ ] `bun-crucible.py pre-merge-gate`'s python dispatch passes on a machine with no root
      `crucible.toml` present.

## Non-goals

- Auditing every other test file that calls `emit_axi` for the same gap. If more are found, that is
  a finding to report (Deferred register), not scope to absorb here.
