# CR-CRU-130 — a milestone is a dated goal, and its type is definable

**Status:** PENDING
**Type:** feature
**Priority:** P2
**Depends on:** CR-CRU-074, CR-CRU-091, CR-CRU-129
**Labels:** feature, server, clients, vocabulary, model
**Phase:** Wave 6 (0.2.0)
**Design reference:** the rule CR-CRU-129 applied to limits, applied to a vocabulary and to a model —
what a project may record, and when it is due, is project data rather than a shape compiled into the
server.

## Context

**A milestone is a goal with a date: what we intend to deliver, when we intend to deliver it, and
when we actually did.** Release is the KEY type of milestone — it carries a release workflow the
others do not — but it is a type, not a separate concept, and every milestone shares its time
properties: a target date, a delivered date, and the gap between them.

The model in the code is inverted. Milestones are records of things that ALREADY happened, with the
dates bolted on where a particular type needed one:

- `release` carries `releasedAt` — a delivered date, and no target date at all.
- `release-proposal` carries `targetAt` — a target date, and no delivered date.
- The two are separate TYPES in `MILESTONE_TYPES`, and a release "consumes" its proposal by stamping
  the proposal's `retired_at` (`src/store.ts:3079` comment: *"A CONSUMED proposal … is prunable
  again — the release it became now carries the fact"*).

So the one thing a milestone is — a dated goal that is later met — is split across two records of two
types, joined by a retirement stamp. `retired_at` on a proposal is standing in for the delivered
date the model does not have. *"The release it became"* says it outright: they are one milestone at
two points in its life.

Everything else gets no dates at all. `gap-analysis`, `design-review`, `stage-flip` and `custom`
cannot express "due by" or "delivered on", so a project cannot ask the one question a milestone
exists to answer: what is due, and what slipped.

**And the type set is closed.** `MILESTONE_TYPES` (`src/v2.ts:1165-1172`) is a `Set` literal in the
server; `POST …/milestones` refuses anything outside it (`:1264`). Six types, chosen by whoever last
edited that file. `custom` is the escape hatch, and it collapses every project-defined milestone into
ONE label — so a project recording two different kinds of dated goal cannot tell them apart, filter
for one, or render them differently. `custom` is a placeholder for the extensibility this CR provides.

The closed set has already drifted from itself: `src/hints.ts:104` holds a SECOND hardcoded copy that
omits `release`, so the help text and the validator have disagreed since CR-CRU-074 added it. Both
are hand-maintained literals — the defect class CR-CRU-129 removed for limits.

**What makes this cheap:** CR-CRU-129 §S1 moved milestones into their own table with `type TEXT` and
no `CHECK`, storing whatever type it is given, and it gives real columns to exactly the fields the
reads filter on. This CR adds two more of those and opens the validator. The live population is 59
milestone rows — 4 releases, 2 proposals, 45 `cr-merged`, 3 `gap-analysis`, 5 `custom`.

## Scope

### §S0 The backend model gains definition; nothing else moves

**This CR changes the STORE'S model and nothing above it.** Stated first because every section below
could be misread as licence to redesign:

- The UI is unchanged — the roadmap graph, the release node, the wave container, the track lanes and
  storyboard F14a render exactly what they render today.
- Behaviours are unchanged — `wave-complete` stays a derived answer over a wave's MEMBERS, `--track`
  keeps deciding order, and the `next` vocabulary is untouched.
- The logical relationships between a SOLO project and a MULTI-TRACK one are unchanged, including
  that a wave is one container either way, that track count is the project's own property, and that
  a trackless project has no lane chrome (`DN-crucible-wave-track-release.md`, D1).
- Wire shapes are unchanged.

What gains definition is the backend: a milestone's dates become first-class, a release stops being
two records pretending to be two types, and the type vocabulary stops being a literal in the server.
Every acceptance criterion below is satisfiable without touching `public/` or any client behaviour.

### §S1 A milestone carries its dates

Every milestone, of every type, carries:

- **`targetAt`** — when it is due. Declared when the goal is set; absent means undated, which is a
  legitimate state for a record of something that simply happened.
- **`deliveredAt`** — when it was met. Absent means outstanding.

Both become filtered columns on the record table, following the seam CR-CRU-129 established for
`type`/`label`/`version`: derived at the single insert point from the same payload fields, so the two
representations cannot disagree. `releasedAt` is the delivered date under its old name and migrates
into it; `targetAt` is already stored by proposals and migrates as-is.

This is what lets a project ask what a milestone is FOR: what is due, what is outstanding, what
slipped and by how long. None of those questions are askable today.

### §S2 A release is a milestone before and after delivery, not two types

`release-proposal` stops being a type. A proposed release is a `release` milestone with a `targetAt`
and no `deliveredAt`; shipping it sets `deliveredAt` along with the commit, `crs` and `packages`. One
record, two points in its life.

The two reads stay, and keep their wire shapes — they are now derived from delivery rather than from
two type names: `listReleaseProposals` is the undelivered releases, `listReleases` the delivered
ones. `retired_at` stops carrying delivery for a proposal, because `deliveredAt` says it directly;
the column keeps its other, real job (CR-CRU-073's gate retirement).

The migration rewrites the 2 live proposals and 4 live releases into the single form, and a proposal
already consumed by a shipped release becomes that release's delivery rather than a second row.

**And the container survives delivery.** A release bundles the CRs of one or more waves — that is the
locked definition (`DN-crucible-wave-track-release.md`, "The three levels") — but measured
2026-09-13, only the PROPOSAL carries the grouping: `0.2.0` and `0.3.0` hold `waves` `['5','6']` and
`['7']`, while every shipped release (`0.1.0`–`0.1.3`) has no `waves` field at all. Shipping drops
it, so a delivered release can say which CRs it bundled but not which waves grouped them.

One record fixes this by construction: `waves` rides through delivery beside `crs`. No new concept —
the field already exists on the proposal, the definition already says a release contains at least one
wave's features, and a wave remains a grouping whose meaning is unchanged for solo and multi-track
projects alike.

### §S3 The release workflow stays a workflow

Release keeps what makes it the key type: propose a target, plan waves into it, ship it, record the
commit, the CRs and the packages, then tag it. **That workflow is distinct from the CR-centred plan
flow and from the roadmap, and this CR does not merge them.** A `plan-file` plans one CR's cycles; the
roadmap sequences CRs into waves; the release workflow governs a dated deliverable that waves belong
to. Unifying the record shape must not blur three flows that answer different questions.

Project-defined types get the dates and nothing else: recorded, queryable, dated, rendered. No
derived workflow, because a workflow is server behaviour.

### §S4 Reserved types stay reserved; every other type is definable

`release` and `cr-merged` carry semantics the SERVER implements and cannot be redefined, shadowed or
removed by configuration:

| type | what the server derives from it |
|---|---|
| `release` | `listReleases` / `listReleaseProposals`, `crs` membership → the queue's `COMPLETED_UNTRACKED`, `packages`, provenance repair, the roadmap strip |
| `cr-merged` | the landing evidence the release ceremony's provenance reads |

A project declaring either name is REFUSED, naming the conflict — silently accepting it would let a
project's narration land in `listReleases` and re-break the membership derivation CR-CRU-129 repaired.

Everything else is declared by the project as configuration: accepted, stored under its own name,
queryable by type, dated, and rendered as itself instead of collapsing into `custom`.
`gap-analysis`, `design-review` and `stage-flip` stop being server constants and become what they
always were — this project's vocabulary — seeded from configuration so nothing that records them
today breaks.

An undeclared type is still refused, and the refusal names how to declare it. Open is not
unvalidated: a typo must not silently become a new category, which is the failure that makes `custom`
look attractive in the first place.

### §S5 One vocabulary, read everywhere

The accepted set has one source. The validator, the refusal's `help[]`, `src/hints.ts`, the five
clients' `--type` help and the board's rendering read it rather than holding a copy.

Measured consequence of not doing it: CR-CRU-128 §S3.3 repaired five `milestone --type` help strings
that enumerated five of six types, and that repair goes stale the moment a project defines a seventh.
A CLI whose help is a literal list cannot describe a configurable vocabulary — it must say where the
list comes from, or read it.

## Acceptance criteria

**§S0 — invariance, asserted rather than promised**
- [ ] No file under `public/` changes, and the roadmap's release node, wave container and track lanes
      render byte-identically — proved by the existing e2e/visual suites passing unmodified.
- [ ] `wave-complete` still reads a wave's MEMBERS only, and `--track` still decides order: the
      resolver's behaviour is unchanged for a solo project and for a multi-track one, asserted with
      the existing `next` suites.
- [ ] Every wire shape a client or the board reads is byte-identical before and after, including
      `GET …/releases`, `GET …/release-proposals`, the queue and the roadmap.
- [ ] No client's behaviour changes beyond the `--type` help §S5 names.

**§S1**
- [ ] Every milestone type accepts and returns `targetAt` and `deliveredAt`, including a
      project-defined type — asserted per type, not once.
- [ ] Both are filtered columns derived at the single insert seam; a test proves column and payload
      cannot disagree, in the shape CR-CRU-129 used for `type`/`label`.
- [ ] Absent is a real state: an undated milestone and an outstanding one both round-trip with the
      field absent rather than zero or epoch.
- [ ] A project can ask what is outstanding and what slipped: milestones are queryable by
      delivered/undelivered and by target date, and the answer includes project-defined types.

**§S2**
- [ ] `release-proposal` is no longer a type, and `listReleases` / `listReleaseProposals` keep their
      wire shapes byte-identically, now derived from `deliveredAt` — proved against a fixture holding
      this project's real population (4 releases, 2 proposals).
- [ ] Shipping a proposed release sets `deliveredAt` on the SAME record: no second row appears, and
      the record's id, `targetAt` and label are unchanged.
- [ ] A proposal already consumed by a shipped release migrates into that release's delivery, not a
      duplicate; re-running the migration changes nothing.
- [ ] `retired_at` no longer carries delivery, and CR-CRU-073's gate retirement still works —
      asserted, because that is the column's remaining job.
- [ ] The roadmap strip and `targetAt` ordering (CR-CRU-091 §S1: proposals ordered by VERSION) are
      unchanged.
- [ ] A DELIVERED release carries its `waves` — the grouping survives shipping, which no shipped
      release does today. Proved against the live shape: `0.2.0` holds waves `['5','6']` as a
      proposal and still holds them once delivered.
- [ ] `waves` is carried, never re-derived: the migration does not invent a wave list for the four
      historical releases that never had one, and reports them as undeclared rather than guessing
      from queue labels.

**§S4**
- [ ] `release` and `cr-merged` cannot be declared, shadowed or removed; the refusal names the type
      and why it is reserved.
- [ ] Each reserved type keeps its derived behaviour, asserted per type.
- [ ] The reserved set exists ONCE: a test fails if a second declaration appears anywhere, including
      `src/hints.ts`.
- [ ] A project-declared type is accepted, stored under its own name, queryable by type — including a
      type the server learned at runtime — and never rewritten to `custom`.
- [ ] An UNDECLARED type is refused, and the refusal says how to declare it.
- [ ] Two distinct project-defined types are distinguishable after the fact — the thing `custom`
      cannot do, and the reason this CR exists.
- [ ] `gap-analysis`, `design-review`, `stage-flip` are seeded from configuration; the 3 live
      `gap-analysis` and 5 live `custom` records still read correctly.

**§S5**
- [ ] No literal copy of the vocabulary remains in server, hint or client source — asserted by
      CONSTRUCTION: a test scans for a hardcoded type list and fails on one.
- [ ] The five clients' `--type` help says where the vocabulary comes from instead of enumerating a
      list configuration can invalidate, and offers a way to SEE the live list; CR-CRU-128's census
      still passes.

## Estimated size

M — two columns, a vocabulary source, a configuration surface, one model unification, and deleting
three copies. The unification is the careful part: it rewrites live release history, 6 rows that
matter more than their number.

## Risk

- **This rewrites release history, again.** CR-CRU-129 exists because that history was already lost
  once. Copy-then-verify with a retained pre-migration snapshot, and the equivalence assertion is
  byte-identical wire output before and after — not "looks right".
- **Reserved-type semantics are the load-bearing half.** A weak §S4 guard lets a project-defined type
  reach `listReleases` and re-break the membership derivation. The per-type behavioural assertions
  are the mitigation, not the naming rule.
- **Three flows, one shape.** Release workflow, CR plan flow and roadmap sequencing answer different
  questions. Giving every milestone dates must not tempt a later CR into merging them; §S3 states the
  boundary so the next author has to argue with it deliberately.
- **An open vocabulary invites typos becoming categories** — mandatory declaration is the answer, and
  "any definable type" means any type a project DEFINES, not any string a caller sends.
- **CR-CRU-129 is in flight.** This CR is sequenced strictly after it merges. It adds columns to the
  table 129 creates rather than changing 129's schema mid-cycle: two migrations over 59 rows is
  cheaper than reopening a landed migration, and it keeps 129 shippable on its own.

## Non-goals

- Merging the release workflow with the CR plan flow or the roadmap. §S3 keeps them distinct.
- Per-type WORKFLOW for project-defined types. They are recorded, dated, queryable and rendered; a
  project wanting derived behaviour is asking for a reserved type, which is a CR, not a configuration
  entry.
- Retention, the record tables' creation, or the `events` move — CR-CRU-129 owns those.
- Removing `custom`. It stays a legitimate "no particular type" label; this CR removes the need to
  abuse it, and 5 live records use it.
- Scheduling, reminders or overdue notifications. This CR makes "what is due and what slipped"
  ASKABLE; acting on the answer is separate work.
