# CR-CRU-106 — a dependency is declared by its own verb

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: none — `cr-plan` and `wave-sequence` already exist and are untouched by this
- **Status**: COMPLETED (0.2.0) — filed 2026-09-04, gap-analysed 2026-09-04 (6 findings; AC5 ruled by
  the user, AC9 simplified, ACs 10-11 added), shipped 2026-09-04
- **Approved by**: the user, 2026-09-04, in the Lavish artifact — **shape A of three offered**, now
  recorded as **step 2b** of the design's ordered call chain

## Problem

**The approved API cannot declare a dependency at all.** The design's §12 ordered call chain is
`register` → `release-propose` → `cr-plan` → `wave-sequence` → `cr-supersede`/`cr-void` → the
execution verbs → `next` → `milestone`. Not one of them carries `dependsOn`.

Yet **93 of the board's 102 rows hold dependencies.** They arrived through the orchestrator's own
bulk queue post — migration tooling built to move this project's README-table roadmap onto the
board, and no part of the approved API. So the dependency graph the roadmap draws, the
dependency-order warning that names offending pairs, and CR-CRU-102's bare `deps 078` annotation all
render data that **a project authored natively in Crucible could never have declared**.

That is the hole. The migration door filled it by accident, which is exactly what hid it.

## The approved shape — A of three

```
cr-depends --cr CR-CRU-079 --on CR-CRU-078,CR-CRU-085
```

- **A — its own verb. APPROVED.** The WHOLE set is the payload; re-sending REPLACES it. This is the
  design's own step-3 argument applied to a second axis: *"The order is the payload. Sending CRs one
  at a time makes their sequence an accident of arrival."* A dependency dropped from a re-sent set is
  a declaration, not an accident. And because deps are their own axis, a re-plan of release or wave
  cannot silently restate or lose them.
- **B — a `--depends-on` flag on `cr-plan`.** Rejected: `cr-plan` is how a CR is re-planned, so every
  re-plan would have to repeat the deps or lose them — the accident-of-arrival failure one axis over.
- **C — folding into `wave-sequence`.** Rejected: a dependency can point at a CR in another wave or
  another release, so the wave call is the wrong container.

## Scope

### §S1 — the verb, and the whole set as payload

A declaring verb naming one CR and the complete set it depends on. Re-sending replaces the set;
sending an empty set is a legitimate declaration that a CR depends on nothing. Following the design's
principle 9, missing targeting ASKS with the live candidates rather than failing blankly, exactly as
`cr-plan` does for `--release`/`--wave`.

### §S2 — the same gates every other declaring verb has

ORCHESTRATOR-gated, and it REFUSES a cycle, naming the offending pair as the existing refusal does.

**It cannot reuse the existing check unchanged, and the gap analysis found why.**
`refuseDependencyCycle` (`src/v2.ts`) documents its own precondition: *"Neither verb edits
`dependsOn`, so the stored graph is the graph the write would leave behind."* Both existing callers
hand it `store.listQueue(...)`. This verb is the FIRST that edits `dependsOn`, so for it the stored
graph is precisely not the post-write graph: a declaration closing a ring would pass and then be
written. The check must therefore run over the PROSPECTIVE graph — the stored rows with the
subject's set replaced by the declared one — and the function's docblock and both callers' comments
must stop asserting a precondition that is no longer true.

### §S2a — a dependency needs a row to belong to

No per-CR store writer can write a dependency today: `upsertQueueEntry` hardcodes an empty
`depends_on_json` on insert and never updates it, and `replaceQueue` — the migration door's writer —
is the only one that writes the column. So this verb needs its own writer, with its own convergence
rule (the upsert's compares release, wave and title only). That writer must NOT create a row: built
on upsert semantics the verb would conjure a CR with no release and no title and hang dependencies
off it. The precedent is settled for the lifecycle verbs, whose hint reads *"a lifecycle disposition
belongs to a registered cr, and neither verb creates one."*

### §S2b — the cycle refusal's remedy stops naming the migration door

The refusal's `help[]` currently reads *"POST …/queue — re-post the queue with X's `dependsOn`
corrected"*: it answers a cycle by sending the caller through the very door this CR routes around,
and a natively-authored project has no queue to re-post. The remedy names `cr-depends` instead.
CR-CRU-104's cycle-asymmetry test cites that hint as the reason the bulk post is a deliberate escape
hatch, so its comment is corrected with the hint. **CR-CRU-104's open ruling — whether the bulk post
should refuse a cycle at all — stays open and is not decided here.**

### §S3 — the migration door is unchanged, and the asymmetry is stated

The bulk queue post keeps CR-CRU-014 §S1's accept-and-flag behaviour for an unknown dependency
target: a bulk import cannot require its own targets to exist yet, because the whole set arrives in
one call. That asymmetry is deliberate and is stated, never silently inherited.

## Acceptance criteria

- **AC1** — `cr-depends` declares a CR's complete dependency set, and the stored row reads back the
  set that was sent, byte-identically. Asserted through the wire, not the store.
- **AC2** — Re-sending REPLACES: a second call with a smaller set leaves the smaller set, and a
  dependency dropped from it is gone. Sending an empty set is accepted and leaves no dependencies.
- **AC3** — The verb is ORCHESTRATOR-gated: an unregistered or non-orchestrator caller is refused,
  with the same meaning `cr-plan` gives that case.
- **AC4** — A declaration that would close a cycle is REFUSED, naming the offending pair, and nothing
  is written. Proven against a real cycle on a real board, not a mock.
- **AC5** — **ANSWERED by the user, 2026-09-04: an unknown target is ACCEPTED and FLAGGED**, in the
  `unknownDependencies` envelope `cr-plan` already returns. The two precedents disagreed deliberately
  — `cr-plan` refuses an unproposed RELEASE, CR-CRU-014 §S1 accepts an unknown `dependsOn` and flags
  it — so the choice was put to the user rather than left to fall out of whichever code path was
  copied. The ruling's reasons, recorded: the cycle check already filters dependencies to known CRs,
  so an unknown target cannot hide a cycle; the reporting envelope exists; and refusing would make
  declaration ORDER-DEPENDENT — a dep could not be declared until every target was planned, which is
  the accident-of-arrival failure this CR's own approved shape argues against.
- **AC6** — Missing targeting ASKS: the client lists the live candidates and exits 2, per the design's
  principle 9, exactly as `cr-plan` does. Never a blank argparse failure.
- **AC7** — No dependency flag or argument appears on `cr-plan` or `wave-sequence` — those are
  shapes B and C, both rejected — and neither verb's BEHAVIOUR changes. Correcting the cycle guard's
  now-false precondition comment (§S2) and the shared remedy hint (§S2b) is required truth repair,
  not a behaviour change, and is explicitly in scope.
- **AC8** — The migration door's accept-and-flag for unknown targets is unchanged, and a test or
  comment states that the asymmetry with AC5 is deliberate.
- **AC9** — The verb returns the same reporting envelope `cr-plan` does, scoped to the CR it
  touched: the dependency-order warning naming the offending pair, and `unknownDependencies`. A
  declaration whose warnings go silent because the verb forgot to name what it touched is the defect
  this criterion catches.

  *Scoped by the gap analysis (dimension 7).* It previously required exercising the browser
  consumers — the bare `deps 078` annotation and drill-through — through the new verb. Both read
  `entry.dependsOn` off the queue payload and cannot know which verb wrote it, and both are already
  covered as pure functions by CR-CRU-102's suite; AC1's byte-identical read-back covers the store.
  A DOM harness proving writer-indifference would have protected nothing.
- **AC10** — `--cr` naming a CR the board does not hold is REFUSED, and nothing is created. A
  dependency belongs to a registered CR; this verb does not conjure one, exactly as the lifecycle
  verbs do not. Distinct from AC5, which governs the TARGETS of a declaration, not its SUBJECT.
- **AC11** — The cycle refusal is proven on a declaration that WOULD CLOSE a ring the board does not
  yet hold — the prospective graph, per §S2 — and not merely on a board that already contains one.
  A guard that only sees the stored graph passes this case and writes the cycle.

## Non-goals

- **Retiring the bulk queue post.** It stays as migration tooling, per the user's ruling.
- **Back-filling the board's 93 existing dependency rows through the new verb.** They are already
  correct data; this CR gives the API the ability to declare them. Migrating the declaration PATH is
  not a data migration.
- **Cross-project dependencies.** `dependsOn` is within one board.
