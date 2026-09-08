# CR-CRU-112 — the gate covers every declared suite

- **Type**: patch
- **Wave**: 5 (0.2.0)
- **Depends on**: 047, 111
- **Status**: PENDING (0.2.0)
- **Design reference**: `docs/research/DN-testing-tiers-in-crucible-projects.md` — "The gate
  contract" (every clause: declared suites, per-stack ingest, `regression` means the union, additive
  never exclusionary, the guarded partition), STANDING DECISION 1, and decision **D4** for the
  declaration seam this CR reads

## Context

`pre-merge-gate` runs `check` (tsc) then `regression` (`bun test`), so it gates exactly what one
runner collects. In this repo that silently excluded **65 files / 1445 tests** of python client
coverage: `clients/bun-crucible.py` contains no `pytest`/`unittest` reference at all.

The cost is measured, not hypothetical. CR-CRU-108 published `tracks` beside `entries` and made an
omitted list a hard stop (`queue-track-fact-unpublished`); that broke CR-CRU-107's AC8 test in
`tests/client/test_plan_file_cycle_flag_help.py`, whose stub published no `tracks`. **Both CRs
shipped green.** Neither gate was faulty — each ran everything it could see, and a suite the gate
cannot see is not gated. Running the python suite by hand on 2026-09-08 found the failure in 82 s.

**Surfaces (verified 2026-09-08):** `cmd_pre_merge_gate` and `cmd_regression` in
`clients/bun-crucible.py`; `_bun_test_cmd`, which builds the invocation from targets or the whole
suite; `_xmlrunner_cmd(python, targets, start_dir, pattern, reports_dir)` in
`clients/python-crucible.py`, which already accepts `--start-dir` and `--pattern`;
`tests/suite-integrity.test.ts`'s `discoveryExclusions` and the `pathIgnorePatterns` assertions.

## Scope

### §S1 A project declares its suites, and the gate runs all of them

The gate's scope becomes the project's declared suites rather than one runner's discovery. A project
declares each suite with the stack that owns it, and each suite ingests through THAT stack's client —
python tests through `python-crucible.py`, TS through `bun-crucible.py`. No client learns to run
another language's tests.

A gate that ran a subset reports as a gate that ran a subset: the envelope names the suites it ran
and, if any declared suite was skipped or unavailable, the gate does not report a pass.

### §S2 `regression` means the union

A `regression` run of a multi-suite project covers every declared suite. Where a project declares
one suite, behaviour is unchanged — this repo's own bun `regression` keeps its current shape and
gains the python suite beside it, not inside it.

### §S3 No suite is gained by hiding files

Suites and targets narrow an invocation by naming paths. Nothing in this CR may introduce a
discovery exclusion: `bunfig.toml` carries no `pathIgnorePatterns` (CR-CRU-047 §S1) and
`tests/suite-integrity.test.ts` asserts the key is absent, because a permanently-excluded directory
makes suite size unreconcilable.

## Acceptance criteria

- **AC1** — with two suites declared (this repo: the bun suite and `tests/client` under python), a
  single gate invocation runs BOTH and its envelope names both, with the per-suite pass/fail counts
  attributed to the suite that produced them.
- **AC2** — a declared suite that fails fails the gate: exit non-zero, `ok:false`, and the failing
  suite named in `warnings[]`. Asserted by planting one failing python test and one failing bun test
  in a fixture project, separately — two assertions, because a gate that only notices the first
  runner's failure is the defect this CR closes.
- **AC3** — a declared suite that cannot be run (missing interpreter, missing start-dir) fails the
  gate with the suite and the reason named. It may NOT be silently skipped, and it may NOT report a
  pass.
- **AC4** — a single-suite project's gate output is unchanged: same steps, same envelope shape, same
  exit codes, asserted against a one-suite fixture.
- **AC5** — each suite's runs are ingested by its own stack's client, asserted on the board rows: the
  python suite's run carries the python stack and the bun suite's run carries the bun stack, from one
  gate invocation.
- **AC6** — `bunfig.toml` still carries no `pathIgnorePatterns` and `tests/suite-integrity.test.ts`
  passes unchanged; the count of discovery exclusions the repo declares is still zero, asserted by
  that file's own `discoveryExclusions` over the real config.
- **AC7** — this repo's own gate, driven end to end, reports the python suite's **1445 tests** beside
  the bun suite's, and the CR-CRU-107/108 regression is demonstrably caught: with the CR-CRU-108
  `tracks` fix reverted in a scratch copy, the gate fails and names the python suite.
- **AC8** — caller existence: a grep at VERIFY time returns ≥1 non-test caller of the multi-suite
  gate path, and the standing python gate step is invoked from the gate itself rather than only from
  documentation.

## Estimated size

M — the declaration seam and the gate's composition. §S2 is a re-reading of an existing verb rather
than new machinery; AC7's reverted-fix reproduction is the expensive assertion.

## Risk

A gate that runs more can fail more, and the first honest run of this repo's gate will surface
whatever else the python suite has been hiding. That is the point, but it means the CR's own gate run
is the first place a pre-existing python failure can appear — which is a finding to record, not a
reason to narrow the gate.

The declaration seam risks becoming a second, competing description of the project's tests beside
the tier targets of CR-CRU-111. One declaration serves both or they will drift; that coupling is why
this CR depends on 111.

## Non-goals

- **Any server-side change.** The gate composes CLIENT-side; each suite ingests through its own
  stack's client using the endpoints and the `{tier, stack, context}` contract the server already
  declares (`src/v2.ts`, `src/store.ts`). No new field, endpoint or enum value.
- Teaching any client to run another language's tests.
- Changing what `e2e` covers or who ingests it (DN open question 5).
- Fixing whatever the python suite reveals beyond the CR-CRU-107/108 case named in AC7.
