# CR-CRU-130 — a milestone type is definable

**Status:** PENDING
**Type:** feature
**Priority:** P2
**Depends on:** CR-CRU-074, CR-CRU-091, CR-CRU-129
**Labels:** feature, server, clients, vocabulary
**Phase:** Wave 6 (0.2.0)
**Design reference:** the same rule CR-CRU-129 applied to limits, applied to a vocabulary — what a
project may record is project configuration, not a set compiled into the server.

## Context

**A release is a key milestone, and the system must be able to record any milestone a project can
define.** Today it cannot. `MILESTONE_TYPES` (`src/v2.ts:1165-1172`) is a closed `Set` literal in the
server, and `POST …/milestones` refuses anything outside it (`src/v2.ts:1264`) with `type must be one
of: gap-analysis, design-review, stage-flip, custom, cr-merged, release`. Six types, chosen by
whoever last edited that file.

The escape hatch makes the gap visible rather than closing it. `custom` exists precisely because the
set is too narrow — but it collapses every project-defined milestone into ONE label, so a project
that records two different kinds of event cannot tell them apart afterwards, cannot filter for one,
and cannot render them differently. `custom` is a placeholder for the extensibility this CR provides.

The closed set has already drifted from itself. `src/hints.ts:104` carries a **second, hardcoded copy**
of the vocabulary — `"type must be one of: gap-analysis, design-review, stage-flip, custom,
cr-merged"` — which omits `release`. The help text and the validator have disagreed since CR-CRU-074
added `release`, and nothing caught it because both are literals maintained by hand.

**The storage is already open.** CR-CRU-129 §S1 moved milestones into their own table with `type TEXT`
and no `CHECK` constraint, and stores whatever type it is given. Only route validation is closed, so
this CR opens a door the schema already permits — no migration, no data movement.

**Not everything can be open, and the distinction is behavioural.** Three types carry semantics the
SERVER implements, and a project redefining them would be redefining the server:

| type | what the server derives from it |
|---|---|
| `release` | `listReleases`, `crs` membership → the queue's `COMPLETED_UNTRACKED`, `packages`, provenance repair, and it retires a proposal |
| `cr-merged` | the landing evidence the release ceremony's provenance reads |
| `release-proposal` | `listReleaseProposals`, the roadmap strip, `targetAt` |

The other three — `gap-analysis`, `design-review`, `stage-flip` — carry no server behaviour at all.
They are narration, and they are exactly the kind of thing a project should be able to define for
itself.

## Scope

### §S1 Reserved types stay reserved

`release`, `cr-merged` and `release-proposal` keep their semantics and cannot be redefined,
shadowed or removed by configuration. A project declaring a type by one of those names is REFUSED,
naming the conflict — silently accepting it would let a project's narration land in `listReleases`
and re-break the membership derivation CR-CRU-129 just repaired.

The reserved set is declared in ONE place and both the validator and the help text read it from
there. `src/hints.ts:104`'s hand-maintained copy is deleted, which also fixes the live drift: it has
omitted `release` since CR-CRU-074.

### §S2 Every other type is definable

A project declares the milestone types it records, as project configuration alongside the parameters
`projects` already carries. A declared type is accepted, stored, queryable by type, and rendered with
its own name instead of collapsing into `custom`.

`gap-analysis`, `design-review` and `stage-flip` stop being server constants and become what they
always were — this project's vocabulary — seeded from configuration so nothing that records them
today breaks.

An undeclared type is still refused, and the refusal names how to declare it. Open is not
unvalidated: a typo must not silently create a new category, which is the failure mode that makes
`custom` look attractive in the first place.

### §S3 One vocabulary, read everywhere

The accepted set has one source. The validator, the refusal's `help[]`, `src/hints.ts`, the five
clients' `--type` help and the board's rendering all read it rather than holding a copy.

This is the measured consequence of not doing it: `CR-CRU-128` §S3.3 repaired five `milestone --type`
help strings that enumerated five of six types, and that repair goes stale the moment a project
defines a seventh. A CLI whose help is a literal list cannot describe a configurable vocabulary — it
must state where the list comes from, or read it.

## Acceptance criteria

**§S1**
- [ ] A project cannot declare, shadow or remove `release`, `cr-merged` or `release-proposal`; the
      refusal names the type and why it is reserved.
- [ ] Each reserved type keeps its derived behaviour, asserted per type: a `release` still reaches
      `listReleases` and still drives `COMPLETED_UNTRACKED`; a `cr-merged` is still read as landing
      evidence; a `release-proposal` still reaches `listReleaseProposals` and still retires on
      release.
- [ ] The reserved set exists once: a test fails if a second declaration of it appears anywhere,
      including `src/hints.ts`.
- [ ] Mutation: renaming a reserved type in configuration does not change what the server derives.

**§S2**
- [ ] A project-declared type is accepted by `POST …/milestones`, stored with its own name, and
      returned as itself — never rewritten to `custom`.
- [ ] It is QUERYABLE by type through the same surface CR-CRU-129 §S3 gave `cr-merged`, including a
      type the server learned at runtime rather than one it shipped with.
- [ ] An UNDECLARED type is refused, and the refusal says how to declare it.
- [ ] `gap-analysis`, `design-review` and `stage-flip` are seeded from configuration, so every
      existing caller keeps working — proved against this project's real store, which holds 3
      `gap-analysis` and 5 `custom` records.
- [ ] Two distinct project-defined types are distinguishable after the fact — the thing `custom`
      cannot do, and the reason this CR exists.

**§S3**
- [ ] No literal copy of the vocabulary remains in server, hint or client source: asserted by
      CONSTRUCTION, a test scans for a hardcoded type list and fails on one.
- [ ] The five clients' `--type` help describes where the vocabulary comes from instead of
      enumerating a list that configuration can invalidate — and CR-CRU-128's census still passes.
- [ ] The refusal's `help[]` lists what this project actually accepts, read live.

## Estimated size

S/M — no migration and no data movement, because CR-CRU-129 already made `type` an unconstrained
column. The work is one vocabulary source, a configuration surface, and deleting three copies.

## Risk

- **An open vocabulary invites typos becoming categories.** §S2 keeps declaration mandatory for
  exactly this reason; "any definable type" means any type a project DEFINES, not any string a
  caller sends.
- **Reserved-type semantics are the load-bearing half.** If §S1's guard is weak, a project-defined
  type could land in `listReleases` and re-break the membership derivation CR-CRU-129 repaired. The
  per-type behavioural assertions are the mitigation, not the naming rule.
- **CR-CRU-129 is in flight.** This CR must not touch the record tables or the migration; it changes
  validation and configuration only. Sequence it after 129 merges.
- **The clients' help becomes indirection.** "The types this project declares" is less immediately
  useful at a terminal than a list. The clients must offer a way to SEE the live list, or this trades
  a stale answer for no answer.

## Non-goals

- Any change to the `milestones`/`gates` tables, the migration, or retention — CR-CRU-129 owns those.
- Per-type semantics for project-defined types. They are recorded, queryable and rendered; the server
  derives nothing from them, and a project wanting derived behaviour is asking for a reserved type,
  which is a CR and not a configuration entry.
- Removing `custom`. It stays as a legitimate "no particular type" label; this CR removes the need to
  abuse it, and 5 existing records use it.
