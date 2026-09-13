# CR-CRU-131 — a limit is configuration, everywhere

**Status:** PENDING
**Type:** fix
**Priority:** P3
**Depends on:** CR-CRU-129
**Labels:** fix, server, clients, configuration
**Phase:** Wave 6 (0.2.0)
**Design reference:** the standing rule CR-CRU-129 §S2 applied to one limit — *a limit is
CONFIGURATION, never a constant compiled into source* — carried to the four that remain and to the
configuration surface itself.

## Context

CR-CRU-129 deleted `DEFAULT_RETENTION = 100` after that literal evicted every release this project
had ever shipped. It removed one limit and left the rule half-applied: **four numeric limits are
still compiled into source**, measured 2026-09-13:

| limit | site | governs | consumers |
|---|---|---|---|
| `TOON_MAX_BYTES = 64 * 1024` | `src/v2.ts:155` | when a TOON envelope is truncated | 3 |
| `TRUNCATE_LIMIT = 200` | `clients/_crucible_axi.py:516` | visible chars of a text field before the size hint | 4 (with `ROADMAP_LIST_LIMIT`) |
| `NO_REPORT_DETAIL_MAX = 500` | `clients/_crucible_axi.py:1045` | how much of a server error detail is shown | — |
| `ROADMAP_LIST_LIMIT = 20` | `clients/_crucible_axi.py:3563` | rows of a roadmap list before `--full` | — |

None of them is reachable by an operator. Each is a number one author chose, governing what every
agent on every project sees — and the retention incident is the precedent for what happens when the
number that was right for its author stops being right for its project.

**And the configuration surface cannot express what the model allows.** `PATCH …/projects/<key>`
refuses `retention: null` *and* `retention: 0`, both with `retention must be a positive integer`.
Two consequences, both measured:

- **An override cannot be CLEARED once set.** This project's cap could only be moved from its
  200,000 incident stopgap to 5000 by writing another number; there is no way to say "inherit the
  fleet default". So `$CRUCIBLE_DEFAULT_RETENTION` governs only projects that have never been
  touched — exactly the projects nobody is thinking about.
- **The route refuses a value the STORE supports.** CR-CRU-129's `enforceRetention` resolves the cap
  with `??` rather than `||` precisely so a declared `retention: 0` stays a cap of zero, and existing
  fold fixtures depend on that. The model accepts 0; the only door to it does not.

## Scope

### §S1 The four limits become configuration

Each resolves from configuration with no literal fallback in source, following the shape CR-CRU-129
established for the retention cap: read at the point of use, not cached at import, so an operator's
change takes effect without a restart — the contract `runAbandonAfterMs()` and `defaultRetention()`
already keep.

Where a limit governs a SERVER behaviour (`TOON_MAX_BYTES`) it is server configuration. Where it
governs a CLIENT's presentation (`TRUNCATE_LIMIT`, `NO_REPORT_DETAIL_MAX`, `ROADMAP_LIST_LIMIT`) it is
client configuration, resolved the way the clients already resolve theirs.

Unconfigured means unbounded, and says so — the rule CR-CRU-129 §S2 settled. For a DISPLAY limit
that is the honest reading: unbounded means "print it all", which is what `--full` already does on
demand. No literal is substituted to make an absent setting look decided.

### §S2 A cap can be cleared, and zero is a cap

`PATCH …/projects/<key>` accepts:

- **`retention: null`** — clear the override; the project inherits the fleet default, and the read
  back says so rather than echoing a number the project does not own.
- **`retention: 0`** — a cap of zero, which the store already implements. The route stops being
  narrower than the model it writes to.

The refusal that remains is for values that are genuinely not caps (negative, fractional,
non-numeric), and it names what it accepts.

### §S3 The rule is enforced where it can be

CR-CRU-129 §S2 proved a constructional guard works: a test scans the retention path for a numeric
literal standing in for a cap and fails on one. That guard is extended to the paths this CR touches —
scoped by name to the resolvers, because a whole-file scan is a false-positive machine (the modules
hold legitimate numbers, and `LIMIT ?` in SQL is not a limit in this sense).

## Acceptance criteria

**§S1**
- [ ] Each of the four limits resolves from configuration; no numeric literal stands in for any of
      them, asserted by CONSTRUCTION per §S3.
- [ ] Each is read at the point of use: changing the setting changes behaviour without a restart,
      asserted per limit rather than once.
- [ ] Unconfigured means unbounded for each, and the behaviour is asserted — a truncating path that
      silently kept a private default would satisfy a weaker test.
- [ ] Configuring a limit changes exactly the behaviour it names and nothing else: TOON truncation,
      field truncation, error-detail truncation and roadmap list length are asserted independently,
      so one setting cannot be wired to another's site.
- [ ] No test pins a limit VALUE: each configures through the real surface and derives expectations
      from what it reads back.

**§S2**
- [ ] `retention: null` clears the override; the project then inherits `$CRUCIBLE_DEFAULT_RETENTION`,
      and a read back reports it as inherited rather than as its own.
- [ ] `retention: 0` is accepted and enforced as a cap of zero — the store already does this, so the
      test proves the ROUTE stopped refusing what the model accepts.
- [ ] A negative, fractional or non-numeric value is still refused, and the refusal names what is
      accepted including `null` and `0`.
- [ ] Mutation: reverting the route to positive-integers-only turns the clear-and-zero tests red.

**§S3**
- [ ] The constructional scan covers the four resolvers and fails on a reintroduced literal, proved
      by mutation per limit.

## Estimated size

S — four resolvers, one route validator, and an extension of a guard that already exists. No
migration, no data movement.

## Risk

- **A display limit resolving to unbounded changes what an agent sees at a terminal.** That is the
  point — `--full` exists for the bounded case and the bound was never anyone's decision — but the
  output of the four surfaces should be eyeballed once, not only asserted.
- **`TOON_MAX_BYTES` guards an envelope some consumer may size-limit.** Check the five clients and
  the board before making it unbounded by default; if a real ceiling exists it is a CONFIGURED
  ceiling with a stated default, not a literal.
- **Clearing an override is a write that removes information.** `null` must be distinguishable from
  "absent from the patch" so a partial PATCH cannot wipe a cap it never mentioned — that is the
  defect this section could introduce while fixing another.

## Non-goals

- Retention's own cap, the record tables or the migration — CR-CRU-129 owns those and shipped.
- Making every number in the codebase configurable. The four named here govern what an operator or
  agent SEES or how much is kept; array bounds, buffer sizes and protocol constants are not limits
  in this sense.
- The milestone type vocabulary — CR-CRU-130 owns that; it is the same rule applied to a vocabulary
  rather than to a number.
