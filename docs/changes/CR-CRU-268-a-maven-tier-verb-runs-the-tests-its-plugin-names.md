# CR-CRU-268 — a maven tier verb runs the tests its plugin names

**Status:** PENDING · filed 2026-11-21 (todo #27; user ruling 2026-11-15: the unit/integration/e2e tier convention
extends to every stack through one standard switch set, which each client translates to its stack's own strategy;
filed for 0.5.0 after the release)
**Type:** maintenance
**Points:** 5
**Wave:** 9 (0.5.0)
**Depends on:** CR-CRU-267 (the shape the stack translations share)
**Labels:** client, maven, tiers
**Design reference:** CR-CRU-261; CR-CRU-267; the gap analysis follows this filing

## Problem

`mvn-crucible.py`'s tier verbs run only what the project declares: a Maven profile whose id is the tier, or a
`[targets.<tier>]` console table. A tier it has not declared is refused.

Maven's own convention already separates the tiers:

- surefire runs the unit tests (`*Test`, `Test*`, `*Tests`, `*TestCase`) in `test`;
- failsafe runs the integration tests (`*IT`, `IT*`, `*ITCase`) in `integration-test` and `verify`.

The client ignores that split, so a standard project gets no `unit` or `integration` verb without a profile written
for the board.

## Behaviour

- **S1 — the verb runs the stack's own split.** The client translates the tier to the plugin that owns it:
  - `unit` runs surefire's tests;
  - `integration` runs failsafe's, with the reports read from `target/failsafe-reports`.

  The gap analysis settles three things:
  - what `module`, `e2e` and `bdd` do;
  - how a project without failsafe configured is answered;
  - whether `integration` skips the unit tests or keeps Maven's phase order.
- **S2 — a declaration still wins.** A declared profile or `[targets.<tier>]` table runs as today.
- **S3 — the gate and `regression` follow.** Each tier the project has is its own suite, filed under its tier.
- **S4 — one switch set.** The verbs, flags and refusals are the ones CR-CRU-267 settles. Only the translation is
  Maven's.

## Acceptance criteria

To be made precise by the gap analysis. At least:

- **AC1** — on a scratch project with surefire and failsafe tests and no tier profile, `unit` runs exactly the
  surefire tests and `integration` exactly the failsafe ones, each filed under its tier.
- **AC2** — a declared tier profile is run in their place.
- **AC3** — `regression` and the gate cover both tiers.
- **AC4** — the RUNBOOK's maven section and `CHANGELOG.md`'s `## [Unreleased]` say how a tier is found.

## Non-goals

- Coverage changes. JaCoCo stays as it is, measured when `--coverage` is given.
- Model B's agent and skill wording.
