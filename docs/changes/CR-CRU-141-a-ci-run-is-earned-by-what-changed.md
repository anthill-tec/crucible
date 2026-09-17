# CR-CRU-141 — a CI run is earned by what changed

**Type** fix · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-137 · **Status** PENDING

## Problem

Every push to `develop`, `master`, `release/**` or `hotfix/**` runs the whole pipeline, whatever it
touched. `.github/workflows/release.yml`'s `push` and `pull_request` triggers carry no path
condition, so the five jobs — `build`, `test-bun`, `test-python`, `test-e2e`, `pack-server` — fire
identically for a source change and for a one-file prose edit.

Measured on this repo's own history (2026-09-17):

| Run | Commit | What it changed | Jobs fired |
|---|---|---|---|
| `35166187151` | `cbe264e` | one CR spec, `38+/8-` | 5 |
| `35164711642` | `5ec7fc5` | PRD paragraph + a DN dating note | 5 |

Both spent a full Playwright tier and an `npm pack` on prose. The `test-bun` step alone runs ~16
minutes; a doc-only commit pays it in full.

**But the naive fix is wrong here, and measurably so.** This project guards its documentation with
tests: **74 test files under `tests/` read documentation**, including `docs/RUNBOOK.md`,
`docs/changes/README.md`, `docs/research/PRD-crucible-v2.md`, the DNs, `CHANGELOG.md`, `AGENTS.md`,
`RELEASING.md`, `STATUS-CONTRACT.md`, and individual CR specs as citation targets. A blanket
`paths-ignore: docs/**` would not save wasted work — it would switch off the guards that make those
documents trustworthy, and the queue/spec structure guards would stop running in CI entirely.

So the requirement is not "skip docs". It is that a run is **earned by what changed**: a change no
test can observe and no artifact can embed runs nothing; everything else runs the full pipeline,
unchanged.

## Scope

### §S1 — a push that no test can observe does not start a run

The `push` and `pull_request` triggers gain a path condition. Its content is not a guess about what
looks inert: a path may be excluded **only if no test reads it and no published artifact embeds
it**, and that set is established by measurement against `tests/` and the packaging manifests, not
by intuition about file extensions.

Two properties make this safe rather than clever:

- **Filtering happens at the trigger, never per job.** `release.yml`'s own header (§S0/§S4) records
  why: the publish gate *is* the dependency graph, and a job that is skipped rather than absent
  makes every `needs:` dependant skip too — publishing nothing, silently. A trigger-level condition
  yields either a complete run or no run at all; the graph is never half-populated. Per-job `if:`
  conditions on changed paths are therefore out of scope, not merely discouraged.
- **Only `push`/`pull_request` are conditioned.** The `release` and `workflow_dispatch` triggers
  carry no changed-file concept and keep firing everything, so no publish path is touched.

`develop` and `master` are unprotected branches today (measured: both return `Branch not protected`),
so no required status check can be left permanently pending by a run that never starts. If branch
protection is ever added, a required check naming a job of this workflow would reintroduce that
hazard — recorded here so the decision is informed rather than rediscovered.

### §S2 — the exclusion list cannot drift away from the tests

A guard asserts the invariant the list depends on: every path pattern excluded by the trigger is
read by **no** test and embedded in **no** published artifact. It derives both sides — it enumerates
the exclusions from the workflow and checks them against the tree — so adding a test that reads a
currently-excluded path, or excluding a path something already reads, fails the suite rather than
quietly removing coverage.

## Acceptance criteria

- [ ] A push whose changed files are all within the excluded set starts **no** workflow run,
      evidenced by a real push and the absence of a run for that commit.
- [ ] A push touching any source, test, packaging or guarded-documentation path still runs all five
      jobs, evidenced by a real run.
- [ ] Every path excluded by the trigger is read by no test and embedded in no published artifact,
      evidenced by the measurement that produced the list.
- [ ] A guard test derives the exclusion list from `release.yml` and fails if any excluded path is
      read by a test or shipped in an artifact — and fails if a newly added exclusion escapes the
      check.
- [ ] No job in the workflow gains an `if:` condition on changed paths; the publish jobs' `needs:`
      graph is byte-identical to before this CR.
- [ ] The `release` and `workflow_dispatch` triggers are unchanged.
- [ ] `release.yml`'s header comment records why the condition sits on the trigger and not on the
      jobs, in the same place §S0 warns against event-scoping them.

## Estimated size

Small. One trigger condition, one guard test, one header paragraph. No job, gate or publish path
changes.

## Risk

- **An over-broad exclusion silently removes coverage.** This is the whole hazard, and why the list
  is measured and guarded rather than asserted. The failure is invisible by construction — CI stays
  green because it never ran — so §S2's guard is the requirement, not a nicety.
- **A future branch protection rule could wedge on a run that never starts.** Not live today
  (measured), recorded in the spec so it is a decision rather than a surprise.

## Non-goals

- Reducing how many times the suite runs **per release** (release branch, master, develop, then the
  release event — four full runs of substantially the same tree before a package uploads). Still
  real, still deferred by CR-CRU-137's non-goals, still its own CR. This CR changes which *pushes*
  earn a run, not how a release sequences them.
- Making the suite itself cheaper — caching, sharding, or trimming the e2e tier. `release.yml`'s
  header explicitly directs cost reduction inside the jobs; that is a separate and larger question.
- Excluding any documentation a test reads. The measurement decides membership; prose is not
  privileged by being prose.
