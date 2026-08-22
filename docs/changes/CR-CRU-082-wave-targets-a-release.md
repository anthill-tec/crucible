# CR-CRU-082 — a wave declares the release it targets

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: 014, 074
- **Status**: PENDING (0.2.0)

## Problem

The governing model is that **a release is a milestone that ends a wave**: a wave's CRs run in
parallel, their features bundle into the release that closes it, and the roadmap then continues
with another wave targeting another release.

Crucible cannot express the second half of that. A release only becomes known when it **ships** —
it is recorded as a `release` milestone at tag time (CR-074, CR-080). So the wave currently being
executed has **no representable terminator**: nothing in the store says "wave 5 targets 0.2.0",
even though the orchestrator knows it and the design board states it outright ("0.2.0 HORIZON —
wave 5").

The consequences are structural, not cosmetic:

- The roadmap graph (CR-077) draws `wave → release → wave → release`. For the **active** wave it can
  draw the CRs and their parallel fan-out, but not the diamond they converge on — so the live wave
  renders as an open end, which is exactly the shape the model says is wrong.
- The roadmap table (CR-078) shows a release reading with a **possible release date**. A wave with
  no declared target has nothing to forecast toward.
- Every CR in flight is, by the model, aimed at a specific release. Today that intent lives only in
  prose on a design board and in the orchestrator's head.

This is the same class of gap CR-080 closed for shipped releases, one step earlier in time: there,
a release had shipped and nothing recorded *what* it shipped; here, a wave is executing and nothing
records *what it is for*.

## Gap analysis (2026-08-22, pre-RED) — decision needed before RED

- **J1 — a per-wave queue field is already DESIGNED, and I am not the first to want one.**
  `DN-crucible-analytics` and CR-022 §S2 both define `targetDate?` **per wave**, with
  `scheduleHealth` derived from it. It exists in **design only**: `targetDate` has **zero**
  occurrences in `src/` or `public/`. So this CR is not inventing a per-wave channel — it is the
  first to *implement* one, and its shape must be chosen so CR-022's `targetDate` later rides the
  **same** channel instead of a second, parallel one.
- **J2 — the existing design is ambiguous about where the field lives, and that is the fork.**
  CR-022's prose says "additive queue field `targetDate?` **per wave**", but its acceptance
  criterion says "**queue entries** accept optional `targetDate`". Per-wave and per-entry are
  different contracts: per-entry allows the CRs of one wave to disagree about their wave's target,
  which the governing model forbids (a wave's CRs bundle into **one** release).
- **J3 — storage consequence.** `queue_entries` is strictly per-CR and `replaceQueue` is a
  DELETE+INSERT transaction over it, so a genuine per-wave channel needs a **sibling table plus a
  migration step** (`SCHEMA_VERSION` 7→8; the chain is additive and already exercised by CR-071).
  A per-entry column needs **no** migration (`size` is the precedent for an optional entry column).
- **J4 — this is a design concept on a shared surface, so it needs a DN and approval.** Standing
  rules: a locked design model gets a **DN** in `docs/research/` first (the CR implements it), and
  design/reference-doc edits need approval because they are cross-CR surfaces. The natural home is
  an amendment to `DN-crucible-analytics`, which already owns per-wave scheduling fields — not a
  new DN competing with it.
- **J5 — no public symbol is removed**, and the PRD says nothing about a planned or target release,
  so the DN is the governing record.

**Verdict: PREREQUISITE_NEEDED — a design decision, not an implementation gap.** The shape of the
per-wave channel is shared with CR-022, so it is settled with the user and recorded in the DN
before this CR's RED, rather than chosen inside an implementation cycle.

## Scope

### §S1 A wave carries its target release

The queue registration — already the roadmap's authored, editable source of truth (a full replace
carrying per-CR `wave` and `dependsOn`) — gains a per-wave **target release** declaration: the
version string that wave is aimed at (`5 → "0.2.0"`).

It belongs there rather than on each CR: the target is a property of the **wave**, and putting it
per-CR would let a wave's CRs disagree about the release they are bundled into, which the model
forbids.

Unset is legitimate: a wave with no declared target is drawn without a terminator, exactly as
today. Nothing is invented.

### §S2 A declared target is not a shipped release

A target is an **intent**, and it must never be mistaken for history. It is exposed distinctly from
`GET …/releases` (which carries only what has actually shipped, with `releasedAt` and `crs`), so a
consumer can never confuse a planned version with a released one. When the wave's release ships,
the recorded release supersedes the declaration for that wave; the declaration is not rewritten
into a fake release record.

### §S3 The roadmap draws the terminator

With a target declared, CR-077 can close the active wave on a **pending** diamond — visually
distinct from a shipped one (it has no date, no commit, no `crs`) — and CR-078's release reading
has something to forecast toward.

## Acceptance criteria

- **AC1** — a queue registration can declare a per-wave target release, and it round-trips: what
  was registered is what is read back.
- **AC2** — a wave with **no** declared target reads back as having none, and nothing synthesises
  one. Absence is a first-class answer.
- **AC3** — a declared target is **never** returned by `GET …/releases`; that route keeps carrying
  only shipped releases. A planned version and a released one are distinguishable by shape, not by
  convention.
- **AC4** — re-registering the queue with a changed target updates it (the roadmap is editable —
  re-sequencing and re-targeting are normal mid-flight operations), and the prior snapshot is
  archived like any other queue change.
- **AC5** — when a wave's target version later ships, the shipped release is what the roadmap reads
  for that wave; the declaration does not shadow it and no duplicate release appears.
- **AC6** — a declared target that is not a valid version string is rejected at registration with a
  structured error, not stored and rendered later.

## Estimated size

S — one optional field on the queue registration, its exposure, and validation.

## Risk

The temptation this CR must resist is letting a *plan* look like *history*. A declared target with
no ship date could easily be rendered as a release that happened, or leak into `GET …/releases` and
poison provenance. §S2 and AC3 exist to keep the two shapes separate.

Second risk: a target declared per-CR instead of per-wave would allow contradiction within a wave.
§S1 places it on the wave for that reason.

## Non-goals

- Forecasting the target's **date** — that is CR-022's confidence-gated P50/P80 band, deferred past
  0.2.0. This CR supplies only the target's identity.
- Consuming the target in the graph or the table — CR-077 §S3 and CR-078.
- Any change to how shipped releases are recorded (CR-074, CR-080) or to provenance (CR-081).
