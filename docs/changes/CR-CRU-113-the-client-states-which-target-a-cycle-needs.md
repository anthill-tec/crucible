# CR-CRU-113 — the client states which target a cycle needs

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: 111
- **Status**: PENDING (0.2.0)
- **Design reference**: `docs/research/DN-testing-tiers-in-crucible-projects.md` — "What an agent is
  expected to run", and decision **D2** (a tier the project has declared no target for is a named
  refusal, not a silent fallback)

## Context

The DN's "What an agent is expected to run" table is a rule with no carrier. Nothing in the client
tells a RED or GREEN agent which target its cycle needs, so the choice is made by whatever the
dispatch brief happened to say — and the fleet's own help templates point only at `test` and
`regression`. The measured consequence of guessing wrong in either direction: a cycle that runs only
the fast target has not exercised a browser contract at all, and a cycle that runs `regression` for
every edit pays **433 s** to learn what **17.8 s** would have told it (this repo, 2026-09-08).

The board already knows what a cycle is for — `plan_cycles` carries each cycle's `kind`
(`red-green | verify | fix`) and its label — and the client already composes per-verb `help[]` and
`_next_start_help` templates. What is missing is the statement joining the two.

**Surfaces (verified 2026-09-08):** `_next_start_help` and `_hold_help`/`_drained_help` in
`clients/_crucible_axi.py`; `resolve_next`/`next_projection` in the same module; `plan_cycles`
(`project_key, cycle_id, plan_id, label, kind, status, seq`) in `src/store.ts`; the tier verbs
CR-CRU-111 §S1 registers.

## Scope

### §S1 The workflow verbs name the target

The verbs that start or advance a cycle state, in their `help[]`, the tier verb the next step should
run — not a generic `test`. A `red-green` cycle's help names the tier the contract under test lives
in; a `verify` cycle's names `regression`, because verification is the union by the DN's gate
contract. The statement is composed from the same tier vocabulary CR-CRU-111 registers, so a project
that declares no target for a tier is told that rather than pointed at a verb that will refuse.

### §S2 The tier a cycle ran is readable back

Given a cycle, the board answers which tiers its runs covered, so an orchestrator closing a cycle
can see that a browser contract was never exercised. This is a READ over what CR-CRU-111 already
stamps — no new field on the wire, and no inference where the tier is absent: a run with no tier
reads as "unstated", never as `unit`.

### §S3 The DN's table ships with the tooling

The situation-to-target mapping the DN states is carried by the client's own help rather than by
documentation an agent never opens: the root help's testing section names the four situations and
their targets in one place, so `--help` answers "which one do I run" without a skill file.

## Acceptance criteria

- **AC1** — a `red-green` cycle's start help names a TIER verb (one of the six), asserted on the
  decoded `help[]` of the real envelope, not on the template string.
- **AC2** — a `verify` cycle's help names `regression`, asserted the same way. A `verify` cycle whose
  help names only the fast target fails this AC.
- **AC3** — where the project has declared no target for the named tier, the help names the missing
  declaration for that stack instead of the verb, joining CR-CRU-111 AC6a. Asserted on a fixture
  project with the declaration absent.
- **AC4** — given a cycle id, the tiers its runs covered are readable in one call, asserted against
  a cycle carrying two runs of different tiers; a run whose tier is absent reads as `unstated` and
  NOT as `unit`.
- **AC5** — the root help of each of the five clients carries the situation-to-target mapping, with
  the four situations and their targets present; asserted by driving `--help` per client, and the
  count of clients exercised is itself asserted.
- **AC6** — no CR-namespace literal reaches any printed help
  (`tests/project-namespace-tripwire.test.ts` AC2 stays green, and its surface count moves by
  exactly the number of verbs this CR adds — quote the count before and after).
- **AC7** — caller existence: a grep at VERIFY time returns ≥1 non-test caller of the target-naming
  composition per client, and the composition is invoked from the workflow verbs rather than only
  from a test.

## Estimated size

S–M once CR-CRU-111 lands — §S1 and §S3 are help composition over an existing vocabulary; §S2 is a
read over a column CR-CRU-111 already populates.

## Risk

Help text is a surface the namespace tripwire polices and the fleet census counts, so this CR moves
two guards it does not own; both moves are asserted in AC6 rather than absorbed silently.

Naming a target in help is advice, not enforcement. If a cycle ignores it, nothing fails — which is
the correct boundary (the orchestrator schedules, the client informs), but it means this CR's value
depends on the dispatch procedure quoting the help it receives. That coupling is stated here rather
than assumed.

## Non-goals

- Enforcing which target a cycle runs, or failing a cycle that ran the wrong one.
- Per-tier coverage (DN open question 4).
- Changing the `kind` vocabulary of a cycle.
