# CR-CRU-141 — a CI run is earned by what changed

**Type** fix · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-137 · **Status** PENDING

> **Deferred out of hotfix 0.2.2 (user ruling 2026-09-17) after gap analysis measured the original
> approach INERT.** The first draft proposed a trigger-level path condition. Its own safety rule —
> and that rule was the best thing in it — makes it a no-op for every case it was filed for. The
> measurement is kept below because it is the thing that stops the next author reaching for
> `paths-ignore: docs/**`. The mechanism is re-opened, not inherited.

## Problem

Every push to `develop`, `master`, `release/**` or `hotfix/**` runs the whole pipeline, whatever it
touched. `.github/workflows/release.yml`'s `push` and `pull_request` triggers carry no path
condition, so five jobs — `build`, `test-bun`, `test-python`, `test-e2e`, `pack-server` — fire
identically for a source change and for a one-file prose edit. `test-bun` alone is ~16 minutes and
`test-e2e` provisions Chromium.

Measured on this repo's own history (2026-09-17):

| Run | Commit | What it changed | Jobs fired |
|---|---|---|---|
| `35166187151` | `cbe264e` | one CR spec, `38+/8-` | 5 |
| `35164711642` | `5ec7fc5` | PRD paragraph + a DN dating note | 5 |

**Why the obvious fix is wrong here, measured rather than argued.** This project guards its
documentation with tests, far more heavily than the first draft of this CR realised — it claimed 74
doc-reading test files; the real figure is **132**. Per path:

| Path the wasted runs touched | Test files that read it |
|---|---|
| `docs/changes/CR-CRU-*.md` | **112** |
| `docs/research/DN-*.md` | 19 |
| `docs/RUNBOOK.md` | 10 |
| `docs/changes/README.md` | 6 |
| `docs/research/PRD-*.md` | 3 |

A blanket `paths-ignore: docs/**` would not remove wasted work — it would switch off 144 guards and
stop the queue/spec/citation invariants running in CI at all.

**And that is exactly why the trigger-condition approach is inert.** The draft's own rule was: *a
path may be excluded only if no test reads it and no published artifact embeds it.* Applied
honestly:

- `cbe264e` touched a CR spec — read by 112 test files. **Not excludable.**
- `5ec7fc5` touched a DN and the PRD — read by 19 and 3. **Not excludable.**

So neither motivating commit would have been skipped. What IS excludable is the set that never
changes: `.omp/` and `.lavish/` carry one tracked file each and appear in **zero** of the last 100
commits' diffs. The CR would have added a trigger condition plus a permanently-maintained derived
guard in order to skip runs that do not occur.

## The real question, re-opened

The waste is real; the lever was wrong. A docs-only push runs 2537 bun tests, a Playwright tier and
an `npm pack` in order to execute ~144 cheap doc guards. So the question is **how to make a
docs-only push cheap without half-populating the publish graph**, and it is harder than the first
draft assumed:

- **Per-job conditions are forbidden, for a reason already recorded.** `release.yml`'s own §S0/§S4
  header notes that a job which is *skipped* rather than absent makes every `needs:` dependant skip
  too — publishing nothing, silently. That is why the draft put the condition on the trigger. Any
  new design inherits that constraint.
- **A docs-only push is not publish-free on every branch.** `publish-testpypi` fires on
  `release/**` and `hotfix/**` pushes and consumes the `dist` artifact, so "docs-only means no
  publish path" is false exactly where release candidates live.
- **The cheap guards and the expensive tiers share one job.** `test-bun` runs the doc guards
  alongside everything else, so the saving is not in *which files changed* but in *which suites a
  change can possibly affect* — a different and larger question, adjacent to the declared-target
  work CR-CRU-133 established.

This CR is therefore re-specified at design time for 0.3.0, with a mechanism chosen against those
three constraints. Candidate directions, none adopted here: a docs-only path that runs the
doc-reading suites only (needs the coupling to be derived, not listed); making `test-e2e`/`pack-server`
conditional at the *trigger* level via a second workflow rather than a job condition; or accepting
the cost and attacking the 16-minute `test-bun` directly, which `release.yml`'s header already
directs cost reduction toward.

## Scope

**Open — to be specified for 0.3.0 against the three constraints above.** Nothing in this CR is
approved for implementation in its current form; the draft's §S1/§S2 (a trigger-level path condition
plus a drift guard over the exclusion list) are withdrawn as measured-inert, not merely deferred.

## Acceptance criteria

To be written with the mechanism. Two survive the rewrite as constraints on ANY design:

- [ ] No documentation a test reads is excluded from verification — membership is established by
      measurement against `tests/` and the packaging manifests, never by file extension or intuition
      about what looks inert. Prose is not privileged for being prose.
- [ ] Whatever gates or narrows a run does so without leaving the publish graph half-populated: a
      complete run or no run, never a skipped job that makes its `needs:` dependants skip.

## Risk

- **An over-broad exclusion silently removes coverage, and CI stays green because it never ran.**
  The failure is invisible by construction. This is why the 132-file measurement above belongs in
  the spec permanently, whatever mechanism 0.3.0 chooses.

## Non-goals

- Reducing how many times the suite runs **per release** (release branch, master, develop, then the
  release event — four full runs of substantially the same tree before a package uploads). Still
  real, still its own CR, still deferred by CR-CRU-137's non-goals.
- Excluding any documentation a test reads.
