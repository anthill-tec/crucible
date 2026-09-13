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

**This SUPERSEDES a recorded decision, and says so because the code says the opposite.**
`src/store.ts:2677-2680` states *"CR-CRU-091 §S1 — a declared target belongs to a PROPOSAL and
nothing else. A `release` carries `releasedAt` (when it shipped); a target it was once aimed at is
not a fact about it"*, and enforces it with `const targetAt = type === "release-proposal" ?
meta?.targetAt : undefined`. The user's 2026-09-13 ruling supersedes that narrower stance: a
milestone is a dated GOAL, so what it was aimed at and when it landed are both facts about it — and
the distance between them is the only thing that can tell anyone a deliverable slipped. The comment
and the gate go together; leaving a comment that contradicts shipped behaviour is the defect
CR-CRU-128 spent a FIX round removing.

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

**What a release CONTAINS at delivery is the flat set of CRs, and that is by design.** A proposal
carries `waves` because waves are how the work is SCHEDULED into it — measured 2026-09-13, `0.2.0`
and `0.3.0` answer `['5','6']` and `['7']` ON THE WIRE. The precision matters to any migration: the
stored payloads carry no `waves` key at all, so `waves` is DERIVED at read time from the roadmap and
there is no stored field for delivery to drop or to carry forward. No shipped release carries them, and the unification must
not "fix" that: user-approved, and it is what the locked definition already says — *"a wave is a
synchronization device, not a delivery bucket… it does not represent a shipment"*
(`DN-crucible-wave-track-release.md`). A release logically contains every CR that contributed to the
functionality and software it released; once delivered, the scheduling grouping has done its job and
the membership is the CR set.

So the unified record keeps `waves` while the release is OUTSTANDING — it is the planning structure a
proposal needs — and delivery does not carry it forward. `crs` remains the authoritative expression
of the bundling, exactly as it is today.

**A ship settles a label even when its date is unknown.** Measured 2026-09-13 while implementing
this section: a release can be posted with NO ship date, from three independent layers —
`scripts/release.sh:733-734` adds `--released-at` only `if [ -n "$ship_date" ]` while
`release_ship_date` (`:405-407`) prints nothing and exits 0 whenever git cannot resolve the sha (a
shallow clone, an unfetched tag object); all five clients declare `--released-at` optional and the
shared payload builder writes it only `if released_at` (`clients/_crucible_axi.py:5423-5424`); and
the route never requires it, by CR-CRU-080 §S4's own rule that a pre-§S4 release carries neither
date.

Before this CR that was harmless, because a ship consumed its proposal by TYPE and needed no date to
do it. Deriving settlement from the date alone would therefore LOSE the cases where the date is
missing: the record would keep its target, gain no date, and stay a live plan — so
`GET …/release-proposals` would keep publishing a shipped label and `cr-plan` would keep accepting
new CRs into it. A 404 would become a 200 in production, reachable from any shallow clone.

So a release is a PLAN while it has declared a target, has no delivery date, **and carries no ship's
evidence**; a record holding a commit, `crs` or `packages` has shipped whether or not anyone could
date it. `deliveredAt` stays honestly ABSENT in that case — nothing is invented, and "derived from
delivery" becomes "derived from delivery or its evidence". The alternative, refusing a dateless
release at the route, was rejected: CR-CRU-080 §S4 documents that shape as legitimate and §S0 freezes
client-visible answers, so refusing it would be this CR overreaching.

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

### §S4b The consumers of "a live proposal", enumerated

§S2 retires `release-proposal` as a type, so every place that reasons about a LIVE proposal now
reasons about an UNDELIVERED release. Each is named because an unenumerated one inverts silently —
and two of them decide whether a CR can be planned at all:

| consumer | site | what it must keep doing |
|---|---|---|
| CR-CRU-118's plannable-target gate | `src/v2.ts:2769` | refuse `release <X> has no live proposal — it is not a plannable target`, byte-identical, now resolved from undelivered releases |
| the shipped-release refusal | `src/hints.ts:404` | *"a release that has already SHIPPED is settled history and is no longer a plannable target"* — now the DELIVERED case |
| three `release-proposals` route sentences | `src/hints.ts:382`, `:398`, `:403` | unchanged wording; the route they name keeps answering |
| proposal convergence | `src/store.ts:2747` | re-proposing one label still converges instead of adding a row |
| `stampProposalRetired`, both call sites | `src/store.ts:2707`, `:2768` | the SHIP call site (`:2707`) goes — delivery is `deliveredAt`. The REVISION call site (`:2768`) stays: `retired_at` means "no longer the live record", which is what it does for a superseded predecessor and for CR-CRU-073's gate alike. What §S2 removes is `retired_at` standing in for DELIVERY, not the column's own meaning |
| `listReleaseProposals` / `listReleases` | `src/store.ts:3263`, `:2717` | same wire shapes, derived from delivery |

### §S5 One vocabulary, read everywhere

The accepted set has one source. The validator, the refusal's `help[]`, `src/hints.ts`, the five
clients' `--type` help and the board's rendering read it rather than holding a copy.

Measured consequence of not doing it: CR-CRU-128 §S3.3 repaired five `milestone --type` help strings
that enumerated five of six types, and that repair goes stale the moment a project defines a seventh.
A CLI whose help is a literal list cannot describe a configurable vocabulary — it must say where the
list comes from, or read it.

**Which means CR-CRU-128's census must be AMENDED, not merely kept green.** It maps `"--type" →
"MILESTONE_TYPES"` (`tests/client/test_cr128_flag_help_census.py:272`) and parses that Set out of
`src/v2.ts` with `_ts_set_members` (`:258`), then asserts the help NAMES every member. Opening the
vocabulary breaks that two ways: the help stops enumerating, and the Set stops being a literal the
parse can read — and its own non-vacuity guard fails on an empty parse, which is the louder failure.

So §S3.3's rule is NARROWED where it is now wrong and kept everywhere it is still right: a flag
drawing on a CLOSED, server-owned vocabulary must still name it (that is `--tier`, `--kind`,
`--cycle-kind`, `--role`, `--source`, and the rule caught a real drift when it shipped); a flag
drawing on a vocabulary a PROJECT defines cannot name it and must instead say where it comes from.
`--type` moves from the first class to the second. The census is amended with that distinction, not
exempted from it — an exemption would leave the next open vocabulary unguarded.

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
- [ ] That query EXTENDS CR-CRU-129 §S3's existing surface (`GET …/projects/<key>/milestones`,
      `listMilestonesByType`, `idx_milestones_project_type`) rather than adding a second record read.
      It stays unwindowed and projection-free, as that route's own rationale requires.
- [ ] `src/store.ts:2677-2680`'s comment and its `type === "release-proposal"` gate are BOTH
      corrected, so no comment survives asserting that a target is not a fact about a release.
      Asserted: a `release` round-trips a `targetAt`, which today is discarded.

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
- [ ] An OUTSTANDING release carries its `waves` exactly as a proposal does today (`0.2.0` →
      `['5','6']`), and a DELIVERED one does not — the scheduling grouping is deliberately not
      carried forward, and `crs` stays the authoritative expression of the bundling.
- [ ] The migration invents no wave list for the four historical releases that never declared one.

**§S4b — every enumerated consumer, asserted per site**
- [ ] CR-CRU-118's gate still refuses a CR planned into a release with no undelivered record, with
      its sentence and `help[]` BYTE-IDENTICAL (`src/v2.ts:2769`) — and still ACCEPTS one planned
      into a release that is undelivered. Both directions, because a gate that refuses everything
      passes a one-sided test.
- [ ] A DELIVERED release is still refused as a plannable target, carrying `src/hints.ts:404`'s
      settled-history sentence.
- [ ] Re-proposing one label still converges to a single record (`src/store.ts:2747`).
- [ ] Shipping sets `deliveredAt` and no longer stamps `retired_at` on the record.
- [ ] `retired_at` still means "no longer the live record": a GATE is still retired by its release
      (CR-CRU-073), and a REVISED proposal still supersedes its predecessor so a label never holds
      two live records — asserted as observable behaviour (exactly one live record carrying the new
      target, the predecessor auditable with the old one), not as a mechanism.
- [ ] A revision is not a delivery: after revising a target, nothing for that label reads as met and
      the releases read stays empty for it.
- [ ] A DATELESS ship settles its label: propose a label, ship it with a commit, `crs` and
      `packages` but NO date, then the gate REFUSES it, `GET …/release-proposals` has dropped it,
      `/releases` serves it, and `deliveredAt` is ABSENT rather than invented. This is the hole the
      evidence clause closes and it is reachable in production from any shallow clone.
- [ ] ONE predicate decides plan-hood, defined once and used by both reads, the ship and the
      filter — not two near-identical copies in different files.
- [ ] The legacy asymmetry is PINNED, not incidental: a dateless release appears in `/releases` AND
      under `?type=release&delivered=false`, because "settled history" and "carries no delivery
      date" are different questions that are both true of it. Both reads document the other.
- [ ] `scripts/release.sh`: a `release_ship_date` that resolves nothing is FATAL to
      `emit_release_milestone`, naming the sha it could not date and the likely cause — and it is
      not swallowed by `report_release`'s post-publication tolerance, which exists so a reporting
      failure cannot unpublish a release, not so a degraded record can pass for a good one.

**Superseded tests — the two-type model**
- [ ] Every test whose SUBJECT is the retired two-type model is DELETED, not inverted, each naming
      the superseded claim: the five cases in `describe("CR-CRU-091 §S1 — a proposed release is its
      own record kind")` (`tests/roadmap-registration-store.test.ts:681-825`), and the
      consumed-proposal-keeps-its-type assertions at `tests/roadmap-registration-routes.test.ts:1553`,
      `:1568`.
- [ ] Tests that merely NAME the old type while asserting something still true are RETARGETED, not
      deleted — the audit read still serves a moved record
      (`tests/milestone-record-read-sites.test.ts:241`,
      `tests/events-feed-after-records-moved.test.ts:279`), the wire control still derives its
      identity keys (`tests/milestone-dates-migration.test.ts:559`), and a legacy pre-migration
      fixture row stays legacy (`tests/milestone-record-migration.test.ts:230`).
- [ ] `tests/roadmap-registration-routes.test.ts:1443-1493`'s tripwire — `release-proposal` is not in
      `MILESTONE_TYPES` and the generic milestone door refuses it — STAYS GREEN and untouched: it was
      never a type on that door, and retiring it as a concept does not make it one.
- [ ] C1's step locator is narrowed from the CR id to `§S1`
      (`tests/milestone-dates-migration.test.ts`, `datesStep()`), because a second CR-130 step makes
      its `owned.length !== 1` throw on every case that calls it.
- [ ] The three `release-proposals` route sentences in `src/hints.ts` are unchanged and the route
      they name still answers.

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
- [ ] `gap-analysis`, `design-review`, `stage-flip` are seeded from configuration; the live
      `gap-analysis`, `custom` and `stage-flip` records still read correctly. Counts are NOT pinned —
      the population grows daily (measured 2026-09-13: 70 milestone rows, `cr-merged` 48, `custom` 7,
      `stage-flip` 5, `release` 4, `gap-analysis` 4, `release-proposal` 2; an earlier draft of this AC
      said 3 and 5 and was already stale within the day). Tests assert floors and derived shape.

**§S5**
- [ ] No literal copy of the vocabulary remains in server, hint or client source — asserted by
      CONSTRUCTION: a test scans for a hardcoded type list and fails on one.
- [ ] The five clients' `--type` help says where the vocabulary comes from instead of enumerating a
      list configuration can invalidate, and offers a way to SEE the live list.
- [ ] CR-CRU-128's census is AMENDED, not exempted: `--type` moves out of the closed-vocabulary map
      (`tests/client/test_cr128_flag_help_census.py:272`) into an OPEN-vocabulary rule that requires
      the help to name its source instead of its members.
- [ ] The closed half keeps its teeth: `--tier`, `--kind`, `--cycle-kind`, `--role` and `--source`
      must still name their server-owned vocabularies, and the census's non-vacuity guard still
      fails on an empty parse. Mutation: stripping a member from one of those help strings turns it
      red, and stripping the SOURCE reference from `--type`'s help turns the open rule red.
- [ ] No census test parses `MILESTONE_TYPES` as a TS `Set` literal any more — the parse that
      breaks when the vocabulary leaves source is removed, not made to tolerate an empty result.

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
- The four numeric limits still compiled into source (`TOON_MAX_BYTES`, `TRUNCATE_LIMIT`,
  `NO_REPORT_DETAIL_MAX`, `ROADMAP_LIST_LIMIT`) and the project route's refusal of `retention: null`
  and `retention: 0` — CR-CRU-131 owns those. Same rule as this CR applies to a vocabulary, applied
  to numbers.
- Removing `custom`. It stays a legitimate "no particular type" label; this CR removes the need to
  abuse it, and 5 live records use it.
- Scheduling, reminders or overdue notifications. This CR makes "what is due and what slipped"
  ASKABLE; acting on the answer is separate work.
