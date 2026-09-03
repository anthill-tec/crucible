# CR-CRU-104 — release membership has one rule, not one per entry point

- **Type**: bug
- **Wave**: 5 (0.2.0) — release membership is the user's call
- **Depends on**: 099 — that CR made the bulk post a declaring path; this one makes it obey the
  same rule as the other one
- **Status**: PENDING (0.2.0) — filed 2026-09-03
- **Found by**: the user, on reading CR-099's close-out: *"end this duality once and for all"*

## Problem

Two paths declare release membership, and they enforce **different invariants**.

| invariant | `cr-plan` (`handleCrPlan`) | bulk `POST …/queue` (`handleQueuePost`) |
| --- | --- | --- |
| ORCHESTRATOR role | yes | yes, since CR-CRU-099 AC9 |
| target must hold a LIVE PROPOSAL | yes, `requireLiveProposal` | **NO — absent** |
| dependency-cycle refusal | yes, `refuseDependencyCycle` | **NO — absent** |
| release-axis scale warning | yes | yes, since CR-CRU-099 §S1 |
| track normalisation + refusal | yes | yes, since CR-CRU-099 §S1 |

**The live-proposal gap is a defect today.** `cr-plan` answers `404 — release <v> has no live
proposal, it is not a plannable target`, which is CR-CRU-091 §S8's rule: a CR may only target a
release somebody proposed. The bulk post asks nothing, so the same orchestrator can store
membership in a release that does not exist as a plan. One route rejects the write the other
accepts.

**Three of those rows were closed by MIRRORING, and that is the disease, not the cure.** CR-CRU-099
taught `replaceQueue`'s defaulting the release axis by copying `upsertQueueEntry`'s comparison,
pre-empted the track refusal by calling the same normaliser, and gated the role by calling the same
`requireOrchestrator`. Each was correct in isolation. Together they mean the rule now exists in two
places, so the NEXT invariant added to one path silently does not exist on the other — which is
exactly how the two rows still marked NO came to be.

The tell: CR-CRU-099's VERIFY had to **construct a board configuration** to prove the two writers
answered identically. Needing an experiment to know whether two code paths agree is the finding.

## Why both doors stay

Neither path is removable, so "delete one" is not the answer:

- `cr-plan --release` is the declaring verb the approved design names
  (`.lavish/crucible-workflow-flowchart.html`, the machinery table's proposed-membership row), and
  it is how a single CR is re-planned or moved between releases.
- The bulk post is the only declaring path the bootstrap and the e2e scenario have. CR-CRU-078
  rewrote `tests/e2e/features/roadmap-graph.feature` to declare a release through it, and that
  scenario had never passed until CR-CRU-099 made the route read the field.

## Scope

### §S1 — one gate, reached from two places

The invariants of declaring release membership become a single decision the two handlers both pass
through, rather than a set each handler re-implements: the live-proposal requirement, track
normalisation and its refusal, and the slot/scale rules that decide `seq` and whether a
`defaulted-seq` warning is earned.

Both routes keep their own shapes where the shape is genuinely theirs — the bulk post validates an
`entries[]` array and refuses by field name AND index, `cr-plan` validates one body and refuses by
field. What must not differ is the ANSWER to "may this membership be written, and what does writing
it earn".

### §S2 — the answer is proven identical, not asserted identical

A test drives the SAME membership declaration through BOTH routes on the same board and requires the
same outcome — accepted or refused, same status, same warning, same stored row. Written so that
adding a future invariant to one path and not the other FAILS, which is the property this CR exists
to buy. CR-CRU-099's convergence probe lived in `/tmp` and was thrown away; this one is in the
suite.

### §S3 — the accepted-field guard measures STORES, not MENTIONS

CR-CRU-099 §S2 left a guard that answers the wrong question, and said so in its own header
(`tests/queue-accepted-field-guard.test.ts`, the "ONE SILENT HOLE" section). It asks whether the
handler NAMES each declared field anywhere in its body. What the defect class needs is whether the
field's value reaches the object handed to the writer.

Those come apart whenever a field is named TWICE — once by a validation, once by the forwarding.
Delete only the forwarding and the field is silently dropped again, while the validation keeps the
guard green. Measured one key at a time against the real route on 2026-09-03: deleting `track`'s
forwarding spread alone left the guard passing 7/7 (`run-9bb593a3`), and it fired only once the
validation went too (`run-ec83722b`); `lifecycle` behaved identically (`run-0f20ebdf` green,
`run-774779c2` red).

**So the guard would not have caught the bug it was written for.** CR-CRU-099's defect was a route
that accepted `release` and stored nothing. `release` is protected today only by accident — it
carries no validation, so its single appearance IS its forwarding.

This belongs in THIS CR rather than a tenth one because it is the same failure as the duality
itself: a check that reports two things agree when it cannot see whether they do. §S2 above buys
that property for the two ROUTES; §S3 buys it for the route-vs-type contract.

What must NOT be lost: the guard's denominator stays the exported `QueueEntryInput` interface, and
it stays unpinned to any count or list, for the reason CR-CRU-099 gave — a pinned list is edited by
the same commit that would forget the field. The named blind spots that remain acceptable
(destructuring, computed keys) stay named.

## Open ruling — NOT decided here

**Should the bulk post refuse dependency cycles?** `cr-plan` and `wave-sequence` do.
`src/hints.ts`'s cycle help names *"re-post the queue with `dependsOn` corrected"* as the remedy,
which reads as the bulk post being the deliberate ESCAPE HATCH from a cycle — and refusing cycles
there could reject a legitimate bootstrap re-post of a README that momentarily contains one, leaving
no way back. CR-CRU-014 §S1 already rules that unknown `dependsOn` targets are ACCEPTED and flagged
rather than rejected, which is precedent for the bulk post being more permissive by design.

This CR therefore does NOT change cycle behaviour on the bulk post. The row stays in the table above
as a known, deliberate asymmetry until the user rules otherwise. Implementing a refusal without that
ruling would repeat CR-CRU-102's `AC19d` — an answer invented without asking.

## Acceptance criteria

- **AC1** — A bulk post declaring a release that holds no live proposal is REFUSED, with the same
  meaning `cr-plan` gives that case: the release is not a plannable target, and the response names
  what to do instead. Nothing is written.
- **AC2** — A bulk post declaring a release that DOES hold a live proposal is accepted exactly as it
  is today, and a post declaring no release stays open to any caller — the bootstrap path
  `queue-file` uses, which sends no identity at all.
- **AC3** — The same membership declaration through both routes produces the same answer on the same
  board: accepted or refused alike, the same stored release/track/lifecycle, and the same
  `defaulted-seq` outcome. Asserted through both wire paths, not through the store.
- **AC4** — Adding an invariant to one declaring path and not the other FAILS a test. Proven by
  making one path skip a shared invariant in a scratch edit and observing the failure, not by
  assertion alone.
- **AC5** — Every refusal and warning message a caller could already see is unchanged in wording, or
  its change is named. Two paths agreeing is the goal; a third wording is not.
- **AC6** — CR-CRU-091's and CR-CRU-095's shipped assertions about `cr-plan` and `wave-sequence`
  behaviour still hold, unweakened. Those CRs are shipped and are not edited.
- **AC7** — The dependency-cycle asymmetry is recorded, not silently closed: a test or a stated
  non-goal makes clear the bulk post's cycle behaviour is deliberate and pending a ruling.
- **AC8** — Deleting a declared field's FORWARDING while leaving any validation of it in place FAILS
  the accepted-field guard. Proven by performing that deletion for each of `release`, `track` and
  `lifecycle` and observing the failure, which is the same experiment that established the hole —
  three of those four mutations pass today.
- **AC9** — The guard still fires when a field is dropped entirely, still refuses to be satisfied by
  DELETING a declaration rather than reading it, and still reports a field named only in a comment
  or only inside a string literal as unforwarded. The shapes CR-CRU-099 bought with a failing
  self-test are not surrendered to buy AC8.
- **AC10** — The guard's denominator remains the exported input interface, unpinned to any count or
  hardcoded field list. A test that must be edited by the commit that adds a field cannot catch that
  commit forgetting the field.
- **AC11** — Whatever blind spots the guard still has after AC8 are named in the file, with the
  measurement that established each. A named limit is the deliverable; an unnamed one is the defect.

## Non-goals

- **Removing either declaring path.** Both are required; see "Why both doors stay".
- **Changing cycle behaviour on the bulk post.** Open ruling above.
- **`queue-file` declaring a release.** Still the client-side gap CR-CRU-099 §S1 scoped out, with its
  own register entry.
- **Editing CR-CRU-091, CR-CRU-095 or CR-CRU-099.** All shipped.
