# CR-CRU-083 — derived status conflates "never started" with "done before tracking existed"

- **Type**: bugfix
- **Wave**: 5
- **Depends on**: 014
- **Status**: PENDING

## Problem

The roadmap derives a CR's status from plan records — `PENDING` (no plan filed), `IN_PROGRESS`
(open plan), `COMPLETED` (closed plan + merge). Deriving rather than reporting is the right
instinct: no extra input to keep in sync.

But `PENDING` carries two incompatible meanings, and the view cannot tell them apart:

1. this CR has not been started;
2. this CR **is finished**, but was executed before plan tracking existed, so no plan row exists.

On the live board that produced a visibly wrong roadmap: **`CR-CRU-001`–`007` and `010` all
rendered `PENDING`** while in reality they are long finished — the earliest work, done before the
plan mechanism was in place. Eight CRs of shipped work presented as not-yet-started, which is what
the user identified when calling the loaded roadmap fundamentally wrong.

It is self-contradictory, not merely untidy: those CRs are in `0.1.0`'s `crs`, so the same board
asserts both "never started" and "a release bundled and shipped it to users". Every consumer of
derived status — graph node styling, table badges, region counts — inherits the contradiction.

And it is **not** fixable by reloading. The queue stores no status by design, so clearing and
re-registering the same rows reproduces the same wrong answer.

## Scope

### §S1 A shipped CR is never `PENDING`

Per `docs/research/DN-crucible-wave-track-release.md`, a release is a specific activity set that
always ships a package to users, and `crs` (CR-080) records the CRs it bundled. Membership is
therefore authoritative evidence of completion: derived status consults it alongside plan records,
and a CR with no plan but with a release can no longer render `PENDING`.

### §S2 Name the third state honestly

A CR finished without plan tracking is not the same as one tracked from RED through merge. It must
not borrow the fully-tracked `COMPLETED` presentation as though its cycles had been observed — that
claims evidence the store does not hold. The distinction is surfaced (for example *completed,
tracking absent*), the same discipline already applied to the omitted release-date row and to an
empty `crs`: state the truth rather than fabricate the richer answer.

### §S3 Absent tracking is a first-class answer

Neither state is an error. A pre-tracking CR is legitimate history and renders without warnings or
empty states, and **no** synthetic plan or cycle rows are created to make the derivation look tidy.

## Acceptance criteria

- **AC1** — a CR present in some release's `crs` with **no** plan record does **not** derive
  `PENDING`. Asserted with the real case: `CR-CRU-001`, in `0.1.0`, no plan.
- **AC2** — a CR with no plan and no release membership still derives `PENDING`; the genuinely
  unstarted case is unchanged.
- **AC3** — a CR completed with full plan tracking is distinguishable from one completed without it;
  the two do not collapse into one badge.
- **AC4** — existing derivations are untouched where plans exist: open plan → `IN_PROGRESS`, closed
  plan + merge → `COMPLETED`.
- **AC5** — no synthetic plan or cycle row is created to satisfy any of the above.
- **AC6** — re-registering the queue changes no derived status (status is not queue data), so the
  fix survives a full replace.

## Estimated size

S — one derivation reading one additional source, plus the presentation split.

## Risk

Derived status is consumed in several places, so this visibly moves numbers on the board. That is
the intent — the current numbers are wrong — but expect the shift rather than reading it as a
regression.

Second risk: treating release membership as proof of completion depends on `crs` being correct.
**CR-081** fixes its known under-reporting; until then a CR missing from `crs` keeps today's
behaviour, so this degrades safely rather than asserting something false.

## Non-goals

- Back-filling plan records for historical CRs — explicitly refused (§S3, AC5).
- Changing what the queue stores; status stays derived, never registered.
- Roadmap ordering and grouping — CR-078.
- Provenance completeness — CR-081.
