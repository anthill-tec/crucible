# CR-CRU-081 — release provenance must use commit ancestry, not merge subjects

- **Type**: bugfix
- **Wave**: 5 (0.2.0)
- **Depends on**: 080
- **Status**: PENDING (0.2.0)

## Problem

CR-080 §S4 gave a release its `crs` — the CR ids it shipped — by scanning the tag range for CR ids
**in merge-commit subjects** (`git log <prev>..<tag> --merges`). That rule silently omits any CR
that landed without a merge commit naming it, so the provenance a release reports is a subset of
what it actually shipped.

Measured on this repo: `CR-CRU-021` and `CR-CRU-023` are both COMPLETED and both shipped in 0.1.0,
yet `git log --merges --grep=CR-CRU-021` finds nothing and they appear in **no** release's `crs`.
By contrast `CR-CRU-011` carries `Merge branch 'feature/CR-CRU-011' into develop` and is found.
Nothing is wrong with the releases or the queue — the *detection rule* is wrong.

CR-080's own gap analysis said as much (F3): commit **ancestry** is the exact, text-independent
rule, and it was set aside only because it was believed to need git in the server. It does not:
the **ceremony** already runs in the repo with git available, and it is the actor that computes
provenance. So the correct rule was reachable all along and subject-matching was the expedient
choice — a wrong one, because it makes provenance depend on commit-message habits.

Why it matters beyond tidiness: `crs` is the roadmap's release-membership source (CR-077 gates
flow with it, CR-078 groups the table with it). An omitted CR renders on the wrong side of a
release boundary, so the view misreports what shipped — the exact class of defect the roadmap work
exists to remove.

## Gap analysis (2026-08-22, pre-RED) — READY

Run per the `gap-analysis` skill, all six dimensions.

- **D2 / D4 — the mechanism this CR assumes exists, and the fix is proven before any code.**
  Every one of the **63** closed plans carries a merge sha, and all 63 resolve as real commits, so
  ancestry has full coverage with no fallback needed. The decisive check: `CR-CRU-021`'s merge
  `c4c192e` and `CR-CRU-023`'s `b99b547` are **both ancestors of `0.1.0`** — so ancestry does place
  the two CRs the subject-scan drops, and AC2 is achievable rather than hopeful.
  **Spec precision:** the plan's field is an object, `merge: {commit: "…"}`, not a bare string.
- **D4 — no reinvention; two existing mechanisms are consumed as-is.** The client already exposes a
  `plans` verb, so the ceremony reads the CR→merge-sha map through it rather than inventing a
  queue-read or touching the DB. And `git merge-base --is-ancestor` is the ancestry primitive — no
  graph walking of our own.
  There is a **second** CR→commit source (40 `cr-merged` milestones). The plan record is chosen as
  authoritative: it is structured, exactly one per CR, and already the close-out artifact, whereas
  the milestone is an event stream that can carry repeats.
- **Where ancestry runs — decided here, not in the cycle.** CR-080 set the boundary: **git lives in
  the ceremony, the DB in the server**, and its GREEN phase then put the queue intersection in the
  shared client because the wire tests pin the server as a verbatim carrier. Ancestry needs *both*
  git and the CR→sha map, so it runs in the **ceremony**: it fetches plans via the client's `plans`
  verb and resolves ancestry with git locally. That preserves 080's boundary — the server still
  never runs git and still stores what it is given.
- **D6 — consumers of the symbol being replaced are enumerated.** `release_crs` exists twice and the
  two are different things: `scripts/release.sh:411` (the subject scan being **replaced**, called
  only at `:457`) and `clients/_crucible_axi.py:1564` (the queue **intersection**, called at
  `:1609`, and **kept** — it is referenced by design comments in `src/store.ts:1711` and
  `src/v2.ts:1152`). Only the shell function's rule changes; the client's intersection stays, so a
  release still never claims CRs the project never registered.
- **D1 / D3 — no PRD conflict.** `DN-release-process.md` mentions provenance but mandates no
  detection rule, and `crs` has no consumer in code yet (it shipped with CR-080), so there are no
  callers passing wrong values. Downstream consumers are **CR-083** (release membership as proof of
  completion) and **CR-078** (the release reading) — 083 is the reason this CR runs first: on
  incomplete `crs` it would leave exactly `CR-021`/`023` wrong after the "fix".
- **D5 — nothing is retired on a claim.** The subject-scan is replaced because it was measured to
  drop real CRs, not because it looked unused.

**Verdict: READY.**

## Scope

### §S1 Ancestry, not text

`crs` for a tag is computed from **commit ancestry**: a CR belongs to a release when its recorded
merge commit is an ancestor of that tag (`git merge-base --is-ancestor <cr-merge-sha> <tag>`), and
it is attributed to the **earliest** tag satisfying that, preserving CR-080 AC10's partition.

The per-CR merge sha comes from the plan record the project already keeps — `merge: {commit}` on a
closed plan, read through the client's existing `plans` verb — so the ceremony resolves CR → sha
without parsing prose and without a new read surface. A CR with no recorded merge sha cannot be
placed by ancestry and is reported as **unplaceable** rather than dropped in silence (§S2).

### §S2 Unplaceable CRs are surfaced, never silently dropped

The ceremony reports a count of CRs it could not place, with their ids. Silence is what let this
bug live: a release that quietly under-reports looks identical to a release that genuinely shipped
less. A tally makes an incomplete `crs` visible at the moment it is produced.

### §S3 Repair the existing records

The three recorded releases carry provenance produced by the old rule (0.1.0 shows 58 CRs and is
missing at least two). Because CR-080 §S3 made release records **immutable** under dedup-replay, a
re-run cannot correct them — so this CR provides an explicit, opt-in repair path that re-derives
provenance for already-recorded releases, rather than requiring a hand-deletion of event rows as I
did during CR-080's dog-food.

## Acceptance criteria

- **AC1** — a CR whose merge commit is an ancestor of a tag appears in that tag's `crs` **even when
  no merge subject mentions it**. Asserted with a fixture whose CR lands via fast-forward or squash,
  which the subject rule cannot see.
- **AC2** — `CR-CRU-021` and `CR-CRU-023` appear in `0.1.0`'s `crs` after the repair. This is the
  concrete regression that exposed the bug.
- **AC3** — attribution stays a **partition**: each CR appears in exactly one release's `crs`, the
  earliest tag containing it (CR-080 AC10 preserved).
- **AC4** — a CR with no recorded merge sha is counted and named as **unplaceable** in the
  ceremony's output; it is never silently omitted.
- **AC5** — the repair path re-derives provenance for an already-recorded release, and is opt-in:
  an ordinary `backfill-releases` re-run remains the idempotent replay CR-080 §S3 defined.
- **AC6** — provenance never depends on commit-message text: a test that rewrites a merge subject
  to remove the CR id must not change the computed `crs`.

## Estimated size

S — swap the detection rule in the ceremony, add the unplaceable tally, add the repair path.

## Risk

Ancestry is O(CRs × tags) `merge-base` calls; on this repo that is trivial, and the ceremony runs
once per release. If it ever matters, `git rev-list <tag>` once per tag and set-membership is the
cheaper equivalent.

The repair path mutates existing release records, which CR-080 deliberately made immutable. It is
therefore opt-in and explicit rather than automatic, so an ordinary re-run cannot rewrite history
by accident.

## Non-goals

- Changing dedup-as-replay for ordinary re-runs (CR-080 §S3 stands).
- Consuming `crs` in the roadmap — CR-077 and CR-078.
- Planned/uncut releases — still unmodelled, still not fabricated.
