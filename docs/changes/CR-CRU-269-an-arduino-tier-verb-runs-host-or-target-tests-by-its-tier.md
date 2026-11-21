# CR-CRU-269 — an arduino tier verb runs host or target tests by its tier

**Status:** PENDING · filed 2026-11-21 (todo #27; user ruling 2026-11-15: the unit/integration/e2e tier convention
extends to every stack through one standard switch set, which each client translates to its stack's own strategy —
arduino's is native host versus HIL/simulation; filed for 0.5.0 after the release)
**Type:** maintenance
**Points:** 5
**Wave:** 9 (0.5.0)
**Depends on:** CR-CRU-267 (the shape the stack translations share)
**Labels:** client, arduino, tiers
**Design reference:** CR-CRU-261; CR-CRU-267; CR-CRU-211 (an arduino agent runs only its own native tests); the gap
analysis follows this filing

## Problem

`arduino-crucible.py`'s tier verbs run only a make target the project declares, named `junit-<tier>`. A tier it has
not declared is refused.

A firmware project's tests have two natural places:

- pure logic compiled and run natively on the host with `g++`;
- code that needs the board, run on hardware in the loop (HIL) or under a simulator.

That split is the tier, and it is the test pyramid the Arduino agents already work by. The client does not know it,
so every project has to restate it as make targets named for the board.

## Behaviour

- **S1 — the verb runs the stack's own split.** The client translates the tier to where the test runs:
  - `unit` runs the native host tests;
  - the tiers that need the board run on HIL or the simulator.

  The gap analysis settles the details:
  - which tier is HIL and which is simulation;
  - how a project declares its HIL rig or simulator;
  - how an absent rig or simulator is answered: refused, never silently skipped;
  - what `module` and `bdd` do.
- **S2 — a declaration still wins.** A declared `junit-<tier>` target runs as today, and CR-CRU-211's own-tests scoping
  is kept.
- **S3 — the gate and `regression` follow.** Each tier the project has is its own suite. A tier that needs hardware
  joins the gate only where the gap analysis rules it may.
- **S4 — one switch set.** The verbs, flags and refusals are the ones CR-CRU-267 settles. Only the translation is
  Arduino's.

## Acceptance criteria

To be made precise by the gap analysis. At least:

- **AC1** — on a scratch firmware project with native tests and no `junit-unit` target, `unit` runs the native host
  tests and files them under `unit`.
- **AC2** — a hardware tier with no rig or simulator declared is refused, naming the declaration.
- **AC3** — a declared `junit-<tier>` target is run in place of the translation.
- **AC4** — the RUNBOOK's arduino section and `CHANGELOG.md`'s `## [Unreleased]` say how a tier is found.

## Non-goals

- Driving a particular simulator or rig vendor beyond the declaration S1 settles.
- Model B's agent and skill wording.
