# CR-CRU-086 — the provenance repair must never erase provenance

- **Type**: bugfix
- **Wave**: 5
- **Depends on**: 081
- **Design**: `docs/research/DN-crucible-wave-track-release.md`
- **Status**: PENDING

## Problem

`backfill-releases --repair-provenance` (CR-081 §S3) **destroyed** the provenance it was built to
correct. Found by dog-fooding it on this project's own releases immediately after merge:

```
BEFORE   0.1.0: 58 CRs      0.1.1: 0      0.1.2: 1
AFTER    0.1.0:  0 CRs      0.1.1: 0      0.1.2: 0
```

Recovered only because a backup was taken first; the wiped store is kept as
`data/crucible.db.wiped-by-081-repair` for forensics.

**Mechanism.** The ceremony derives `crs` by ancestry and then hands it to the client, whose
`release_crs` **intersects it with the registered queue** (CR-080 §S4 — a release must never claim
CRs the project never registered). The live queue was **empty at the time**, so the intersection
correctly produced the empty set — and the repair then **wrote that empty set over 58 good CRs**.
The ceremony even said so plainly: `crs=(none registered)`.

CR-081's GREEN claimed the safe behaviour — *"an absent field means git could not answer, so the
stored value is left alone rather than erased"* — and that is true for an **absent** field. But an
**empty list is not absent**: it is a present, well-formed answer meaning "nothing", so the repair
dutifully persisted it. The distinction between *"I have no answer"* and *"my answer is nothing"*
was never drawn on the write path.

**Why the tests missed it.** Every §S3 fixture registers a queue before repairing, so the
intersection is never empty in test. The destructive path only appears when the queue is
unregistered, empty, or unreachable — which is precisely the state a real project is in after
clearing its roadmap, or before its first `queue-file`. A test suite that always seeds the queue can
never see it.

This is more dangerous than the bug CR-081 fixed. Under-reporting provenance is a wrong answer;
erasing it destroys the record of what a release delivered, and CR-083 is about to treat release
membership as proof of completion.

## Scope

### §S1 An empty derivation never overwrites a stored set

On the repair path, an **empty** `crs` is treated as *no answer*, not as *the answer*: the stored
value is left untouched. Only a **non-empty** derivation may replace a stored set. The same rule
applies to `releasedAt` — a missing or unresolvable date never blanks a stored one.

### §S2 A repair that cannot compute refuses, loudly

If the queue is unregistered, empty or unreachable, the repair **refuses that release and says
why**, rather than proceeding with a set it knows is degraded. Silence is what made this
destructive: the ceremony printed `crs=(none registered)` and then wrote anyway. Refusal is
per-release and non-fatal — the ceremony continues and reports which releases were skipped and why.

### §S3 Never a silent shrink

Any repair that would **reduce** a stored `crs` is surfaced before it is applied: the count
before, the count after, and the CR ids being removed. A genuine correction that legitimately
shrinks a set (the 58→51 case, where nine CRs have no landing record) is legitimate and must remain
possible — but it is reported, never silent.

## Acceptance criteria

- **AC1** — with a stored non-empty `crs` and an **empty** derivation, the repair leaves the stored
  `crs` **unchanged**. Asserted with the exact live shape: 58 stored, empty derived, 58 after.
- **AC2** — with a stored `releasedAt` and no derivable date, the stored value is unchanged.
- **AC3** — with an **unregistered or empty queue**, the repair **refuses** the affected releases,
  names them and the reason, and exits non-fatally having written nothing.
- **AC4** — a **non-empty** derivation still replaces a stale stored set (CR-081 AC5 preserved), so
  this fix does not disable the repair.
- **AC5** — a repair that shrinks a stored set reports the before/after counts and the removed ids.
- **AC6** — idempotency and the partition are preserved (CR-081 AC7, AC8 still green).
- **AC7** — a regression test drives the repair with **no queue registered**, so the destructive
  path is permanently covered. Every existing §S3 fixture seeds a queue, which is exactly why this
  shipped.

## Estimated size

S — a guard on the write path, a refusal path, and a shrink report.

## Risk

The guard must not silently entrench stale provenance: §S2's loud refusal exists so "nothing was
written" is never mistaken for "nothing needed writing". AC5 covers the converse — a legitimate
shrink must stay possible, or the repair cannot fix the very under-reporting CR-081 addressed.

## Non-goals

- Changing ancestry derivation or the queue intersection (CR-080 §S4, CR-081 §S1) — both are
  correct; only the **write** decision was wrong.
- Restoring the wiped data — already recovered from backup before this CR was filed.
