# CR-CRU-106 — a dependency is declared by its own verb

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: none — `cr-plan` and `wave-sequence` already exist and are untouched by this
- **Status**: PENDING (0.2.0) — filed 2026-09-04
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

ORCHESTRATOR-gated, and it REFUSES a cycle the way `cr-plan` already does through
`refuseDependencyCycle`. The refusal names the offending pair, as the existing one does.

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
- **AC5** — **The unknown-target question is ANSWERED, not inherited.** A dependency naming a CR the
  board does not hold is either refused or accepted-and-flagged, and the choice is stated with its
  reason. The two precedents disagree deliberately — `cr-plan` refuses an unproposed RELEASE, while
  CR-CRU-014 §S1 accepts an unknown `dependsOn` and flags it — so this AC exists to force the
  decision into the open rather than let it fall out of whichever code path was copied.
- **AC6** — Missing targeting ASKS: the client lists the live candidates and exits 2, per the design's
  principle 9, exactly as `cr-plan` does. Never a blank argparse failure.
- **AC7** — `cr-plan` and `wave-sequence` are UNCHANGED. No dependency flag appears on either — those
  are shapes B and C, both rejected.
- **AC8** — The migration door's accept-and-flag for unknown targets is unchanged, and a test or
  comment states that the asymmetry with AC5 is deliberate.
- **AC9** — The roadmap's existing dependency consumers work on data declared through the new verb:
  the dependency-order warning naming offending pairs, the bare `deps 078` annotation (CR-CRU-102),
  and drill-through targeting. Proven by declaring through `cr-depends` and exercising each, not by
  inspecting the payload.

## Non-goals

- **Retiring the bulk queue post.** It stays as migration tooling, per the user's ruling.
- **Back-filling the board's 93 existing dependency rows through the new verb.** They are already
  correct data; this CR gives the API the ability to declare them. Migrating the declaration PATH is
  not a data migration.
- **Cross-project dependencies.** `dependsOn` is within one board.
