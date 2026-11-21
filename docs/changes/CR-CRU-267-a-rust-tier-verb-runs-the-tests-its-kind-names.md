# CR-CRU-267 — a rust tier verb runs the tests its kind names

**Status:** PENDING · filed 2026-11-21 (todo #27; user ruling 2026-11-15: the unit/integration/e2e tier convention
extends to every stack through one standard switch set, which each client translates to its stack's own strategy;
bun and python came first in 0.4.0, CR-CRU-261; filed for 0.5.0 after the release)
**Type:** maintenance
**Points:** 5
**Wave:** 9 (0.5.0)
**Depends on:** —
**Labels:** client, rust, tiers
**Design reference:** CR-CRU-261 (tiers by directory, bun and python); CR-CRU-196 (Go tiers by build tag); the gap
analysis follows this filing

## Problem

Every client already offers the same tier verbs: `unit`, `module`, `integration`, `e2e`, `bdd` and `regression`.
What a verb runs differs from stack to stack:

- **bun and python** take the tier from the directory (CR-CRU-261);
- **go** takes it from a build tag (CR-CRU-196);
- **rust** takes it from the project, which must declare a nextest profile named after the tier
  (`[targets.<tier>]`). A tier it has not declared is refused.

A Rust crate already has the split the tiers name:

- unit tests are the in-crate `#[cfg(test)]` modules, which nextest calls the `lib` and `bin` kinds;
- integration tests are the crate's `tests/` directory, the `test` kind.

Even so, `rust-crucible.py unit` on a crate that declares no profile runs nothing, and the agent has to be told
the profile. That is the opposite of the standard set: the verb names the tier, and the client should know where
the stack keeps it.

## Behaviour

- **S1 — the verb runs the stack's own split.** The client translates the tier to nextest's kind filter:
  - `unit` runs the `lib` and `bin` kinds, the in-crate tests;
  - `integration` runs the `test` kind, the crate's `tests/` directory.

  The gap analysis settles `module`, `e2e` and `bdd`, which have no Rust idiom. Each is either declared-only, as
  today, or refused, naming the declaration.
- **S2 — a declaration still wins.** A project that declares `[targets.<tier>]` runs its declared profile, as today.
- **S3 — the gate and `regression` follow.** `regression` runs every tier the crate has, and the gate files each as
  its own suite, as the declared tiers are now. `e2e` stays excluded from the gate.
- **S4 — one switch set.** The verbs, flags and refusals are the ones the other clients use. Only the translation is
  Rust's.

## Acceptance criteria

To be made precise by the gap analysis. At least:

- **AC1** — on a scratch crate with both in-crate tests and a `tests/` directory, and no `[targets]` table, `unit`
  runs exactly the in-crate tests and `integration` exactly the `tests/` ones. Each is filed under its own tier.
- **AC2** — a declared `[targets.unit]` profile is run in place of the kind filter.
- **AC3** — `regression` and the gate cover both tiers, each filed under its tier.
- **AC4** — the RUNBOOK's rust section and `CHANGELOG.md`'s `## [Unreleased]` say how a tier is found.

## Non-goals

- The other stacks: maven is CR-CRU-268 and arduino is CR-CRU-269.
- Model B's agent and skill wording. Crucible sends the switch set to Model B as a request once the stack CRs land.
