# CR-CRU-180 — the release's CI suites pass on a clean runner

**Type** fix (patch CR, release blocker) · **Points** 5 (set at filing, 2026-10-10, from the diagnosis below) ·
**Wave** 7 (0.3.0) · **Depends on** CR-CRU-179 · **Status** PENDING — filed 2026-10-10 (user ruling: diagnose
and fix in 0.3.0; the release waits)

## Problem

The 0.3.0 rehearsal (`scripts/release.sh checkpoint`, run 37989106984 on `release/0.3.0` at `10ffbd0`) is
red on GitHub's runner — 1 bun test, 6 python tests and 1 webkit e2e scenario — though the same tree is
green locally (bun 3329/0, python 2411/0, e2e 1227/0, filed under release 0.3.0). Every publish job
`needs:` the three suites, so nothing ships. CI on `develop` has been red on every push since 2026-09-22
(run 36081178630; the last green was 35353919400, 2026-09-18), unnoticed because no release ran in between.

## Diagnosis (2026-10-10, from the CI logs)

1. **bun — `tests/e2e-suite-reaches-the-board.test.ts`** ("a real client drive of the e2e suite lands the
   Gherkin on the board > the ingest carries scenario-level detail"). Fails on CI since run 36081178630,
   passes locally. Cause to establish (the drive's environment on a clean runner: browsers, ports, the
   scratch board).
2. **python — 5 tests in `tests/client/test_crucible_axi_shared.py`** (`CmdStatusOpenPlansOnlyContractTest`
   AC5/AC6) assert `warnings == []` / `["status-unavailable"]` but receive a `limit-configuration` warning:
   "no readable configuration. Tried … /home/runner/work/crucible/crucible/crucible.toml". Locally they pass
   only because this checkout has a gitignored `/crucible.toml`. The tests are not hermetic: they read the
   developer's own configuration.
3. **python — `tests/client/test_a_gate_is_running_only_while_its_run_is_driven_or_held.py`**
   `AnInterruptedGateRunStillRemovesItsRunIdentityTest` (client=bun, SIGTERM): the SIGTERM'd gate-run posted
   its heartbeat but no removal on the runner (CR-CRU-176). A real interrupt-path defect on a slower machine,
   or a race in the test; to establish.
4. **e2e (webkit-iphone only) — `mobile-viewport-responsive.feature`** "CR-CRU-146 — at the phone band a
   history cycle line … a tap on its own empty space opens its linked runs": the tap does not open
   `cycle-span-closed`. Chromium passes; webkit is not run locally (it is endpoint-gated via Docker), so a
   0.3.0 change to the cycle line or History (CR-CRU-172/173/176/178/179) may have broken the tap on WebKit.
   A real defect until shown otherwise.

## Steps

### §S1 — each failure is fixed at its cause

Each of the four is diagnosed to its cause and fixed there: a product defect in the product, a test that
reads the developer's machine made hermetic (its assertions unchanged), a race removed rather than waited
out. No test is skipped, deleted, retried or loosened to pass.

### §S2 — CI is the judge

A `release.yml` workflow dispatch (rehearsal-only, no publish) on the fixed head runs green: build,
`test-bun`, `test-python`, `test-e2e` (all projects, webkit included), `dry-run-npm`, `publish-testpypi`.

## Acceptance criteria

- [x] Each of the four failures has a stated cause and a fix at that cause; no test is skipped, deleted,
      retried or has an assertion weakened — asserted by VERIFY reading the diffs.
- [x] The python client suite passes with no `crucible.toml` at the repo root (as on a clean runner) —
      asserted locally by running it with that file moved aside, through the client.
- [x] A `release.yml` dispatch on the fixed head is green end to end (all jobs succeed, webkit included)
      — the run id is recorded in VERIFY's report.

## How it is worked

Directly on `release/0.3.0`, one commit per fix (git flow: release fixes go on the release branch and
reach develop at finish; user ruling 2026-10-10 — no separate bugfix branch). Cycles: fix the python hermeticity
(2); fix the gate-run interrupt on a slow runner (3); fix the e2e drive on a clean runner (1); fix the
WebKit tap (4, RED first); verify with a CI dispatch.
