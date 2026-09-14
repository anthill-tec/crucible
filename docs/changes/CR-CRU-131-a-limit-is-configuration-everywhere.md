# CR-CRU-131 — a limit is configuration, everywhere

**Status:** PENDING
**Type:** fix
**Priority:** P3
**Depends on:** CR-CRU-129, CR-CRU-130
**Labels:** fix, server, clients, configuration
**Phase:** Wave 6 (0.2.0)
**Design reference:** the standing rule CR-CRU-129 §S2 applied to one limit — *a limit is
CONFIGURATION, never a constant compiled into source* — carried to every limit that remains, and to
the configuration surface itself.

## Context

CR-CRU-129 deleted `DEFAULT_RETENTION = 100` after that literal evicted every release this project
had ever shipped. It removed one limit and left the rule half-applied. Measured 2026-09-14, **six**
numeric limits are still compiled into source:

| limit | site | governs | reached by |
|---|---|---|---|
| `TOON_MAX_BYTES = 64 * 1024` | `src/v2.ts:160` | when a TOON envelope is truncated | every AXI read |
| `DEFAULT_RUN_ABANDON_MS = 30 * 60_000` | `src/store.ts:834` | how long an OPEN run may live before the sweep abandons it | every ingest |
| `DEFAULT_PROJECT_INACTIVE_MS = 3_600_000` | `src/v2.ts:362` | when a project reads as inactive | every project read |
| `TRUNCATE_LIMIT = 200` | `clients/_crucible_axi.py:516` | visible chars of a text field before the size hint | all five clients |
| `NO_REPORT_DETAIL_MAX = 500` | `clients/_crucible_axi.py:1045` | how much of a server error detail is shown | all five clients |
| `ROADMAP_LIST_LIMIT = 20` | `clients/_crucible_axi.py:3563` | roadmap rows before `--full` | all five clients |

**The rule's own exemplar breaks it.** `runAbandonAfterMs()` (`src/store.ts:836-839`) is the function
CR-CRU-129 held up as the pattern to copy — *"read per sweep, not cached: the deadline is
operational configuration"* — and its fallback is `DEFAULT_RUN_ABANDON_MS`, a literal. A CR that
fixes the others and leaves the exemplar broken teaches the next author the wrong lesson from the
best-documented example in the tree.

**And the configuration surface cannot express what the model allows.** `PATCH …/projects/<key>`
refuses `retention: null` *and* `retention: 0`, both with `retention must be a positive integer`.
Two consequences, both measured:

- **An override cannot be CLEARED once set.** This project's cap could only be moved from its
  200,000 incident stopgap to 5000 by writing another number; there is no way to say "inherit the
  fleet default". So `$CRUCIBLE_DEFAULT_RETENTION` governs only projects nobody has touched —
  exactly the projects nobody is thinking about, which is how `Model B` and `Sandesh` sat unbounded
  until CR-CRU-129's boot disclosure named them.
- **The route refuses a value the STORE supports.** `enforceRetention` resolves the cap with `??`
  rather than `||` precisely so a declared `retention: 0` stays a cap of zero, and existing fold
  fixtures depend on that. The model accepts 0; its only door does not.

### What "configuration" means here, and what it does NOT mean

Deleting a literal is not the same as deleting a limit. Retention could become unbounded-when-unset
because keeping more events costs **disk**, and CR-CRU-129 made that safe by disclosing it at boot.
**That reasoning does not transfer to the other five.** `TRUNCATE_LIMIT` and `ROADMAP_LIST_LIMIT`
bound what an agent READS, and they exist to protect the reader's context — unbounded-by-default
would print every field in full and the whole 128-row roadmap on every call, for every agent, and
call it honesty. `TOON_MAX_BYTES` is a real ceiling driving the truncating loop at `src/v2.ts:204`,
so a consumer may depend on it. An absent run-abandon deadline would leave open runs open forever.

So a limit resolves from configuration, and **when nothing is configured it resolves to a default
that lives in CONFIGURATION TOO** — a shipped, EDITABLE, documented defaults file, not a number a
reader has to find in a source file. That is the rule: the VALUE is always configuration. Whether it
is overridden is the operator's business; whether it is legible and editable is not optional.

### Where the defaults live: `crucible.toml`, read by both stacks

TOML, and the capability is already in the tree on both sides — verified 2026-09-14:

- **Bun parses TOML natively.** `import cfg from "./crucible.toml"` yields the parsed table; probed
  and confirmed.
- **Python reads it with `tomllib`** (stdlib since 3.11; this repo runs 3.14). Already used at
  `clients/rust-crucible.py:84` and `tests/client/test_cr040_coverage_tooling.py:35`, so it is an
  established dependency rather than a new one.
- The repo already carries root-level TOML config (`bunfig.toml`, `pyproject.toml`), so a
  `crucible.toml` sits where an operator would look for it.

ONE file, a `[limits]` table, one entry per limit. The file is the documentation an operator meets
first; `docs/RUNBOOK.md` carries the same set as prose with the override order.

**Each limit is declared with five things, not one number:** `description` (what it governs, in a
sentence an operator can act on), `recommended` (the value we ship and stand behind — today's
compiled value), `min` and `max` (the range outside which the value is not supportable), and `env`
(the environment variable that overrides it).

**The range is ENFORCED, not decorative.** A stated bound that nothing checks is the defect this
project keeps finding: a budget declared in one place and unbounded content arriving from another. A
configured value outside `[min, max]` is REFUSED at resolution, with a message naming the limit, the
offending value, the range and the recommended setting. It is NOT silently clamped — a clamp leaves
the operator's stated intent and the running behaviour different with nothing saying so.

**The range has ONE source: the file.** The validator reads `min` and `max` from the same table the
operator edits, so the documented bound and the enforced bound cannot drift. That is the failure this
CR family has already hit twice — `src/hints.ts` holding a second hand-maintained copy of the
milestone vocabulary that omitted `release` for a month, and `src/types.ts` still documenting
`retention` as "(default 100)" after CR-CRU-129 deleted that literal. A second copy of a bound would
be the third.

`min` and `max` are a supportability judgement, so the implementation states them and states the
reasoning per limit: a truncation width of 0 shows nothing, and a run-abandon deadline of one second
abandons every live run, so both have floors that are more than "positive".

**Three layers, in precedence order**, which is the order the code already half-implements:

1. `crucible.toml` `[limits]` — the shipped, editable default.
2. the environment variable — per-deployment override (`$CRUCIBLE_DEFAULT_RETENTION`,
   `$CRUCIBLE_RUN_ABANDON_MS` and the rest, one per limit, named in the file's comments).
3. a per-project value where one exists (`projects.retention`) — narrowest wins.

**Read at the point of use, not imported at module load.** A static `import` caches the table, which
would break the no-restart contract `runAbandonAfterMs()` already keeps; the file is read when the
limit is needed. That is a REQUIREMENT on the mechanism, and the tests assert the behaviour — edit
the file, the next call changes — rather than the reading technique.

And a documentation debt this CR pays off rather than adds to: `docs/RUNBOOK.md` documents NEITHER
`CRUCIBLE_DEFAULT_RETENTION` nor `CRUCIBLE_RUN_ABANDON_MS` today (measured — grep finds neither).
Two limits were already operator-configurable and no operator could have known.

## Scope

### §S1 Every limit resolves from configuration, including its default

The six limits resolve at the point of use from configuration, with no numeric literal standing in
for any of them anywhere in source. Read at the point of use, not cached at import, so an operator's
change takes effect without a restart — the contract `runAbandonAfterMs()` and `defaultRetention()`
already keep, and which this CR completes rather than invents.

Each has a **shipped default in a configuration source**, and the implementation states where that
source lives. An unconfigured limit resolves to its shipped default; it does NOT become unbounded.
The one limit for which unbounded IS the right answer — retention — keeps the behaviour CR-CRU-129
shipped, and keeps its boot disclosure: this CR brings retention's FALLBACK into the same defaults
source without changing that an operator who configures nothing gets no cap, because that decision
was taken deliberately and disclosed loudly.

**The clients need a settings seam and do not have one.** They read `os.environ` and `_read_env`
ad hoc for `CRUCIBLE_PROJECT_KEY` and the `WORKFLOW_*` variables; there is no place a limit's value
or its default lives. §S1 builds that seam ONCE in `clients/_crucible_axi.py`, where all five
clients inherit it — the same shared-module discipline CR-CRU-030 established. The three display
limits then resolve through it.

`--full` keeps working exactly as it does: a per-invocation escape hatch is not a substitute for a
configured default, and a configured default is not a substitute for it.

### §S2 A cap can be cleared, and zero is a cap

`PATCH …/projects/<key>` accepts:

- **`retention: null`** — clear the override; the project inherits the fleet default, and the read
  back reports it as INHERITED rather than echoing a number the project does not own.
- **`retention: 0`** — a cap of zero, which the store already implements.

The refusal that remains is for values that are genuinely not caps (negative, fractional,
non-numeric), and it names what it accepts.

`null` must be distinguishable from **absent from the patch**, or a partial PATCH silently wipes a
cap it never mentioned. That is the defect this section could introduce while fixing another.

### §S3 The rule is enforced by extending a scan that exists

Two constructional scans already exist and both were hardened by review:
`tests/retention-disposable-kinds.test.ts` (CR-CRU-129's cap-literal scan, scoped by function name
so the module's legitimate numbers are not false positives) and
`tests/milestone-vocabulary-has-one-source.test.ts` (CR-CRU-130's, whose `READING_SITES` VERIFY
extended to `src/server.ts`, `bin/crucible-server.mjs` and the shared client module).

§S3 **extends** one of them rather than adding a third walker — the "no seventh walker" discipline
CR-CRU-128 §S2 established. Scoped by name to the resolvers, because a whole-file scan is a
false-positive machine: the modules hold legitimate numbers and `LIMIT ?` in SQL is not a limit in
this sense.

## Acceptance criteria

**§S1**
- [ ] Each of the SIX limits resolves from configuration; no numeric literal stands in for any of
      them in source, asserted by CONSTRUCTION per §S3. The six are enumerated in the Context table
      and the count is asserted, so a seventh added later fails rather than passing unnoticed.
- [ ] Each resolves at the point of use: changing the configured value changes behaviour WITHOUT a
      restart — asserted per limit, not once.
- [ ] An unconfigured limit resolves to its SHIPPED DEFAULT, not to unbounded — asserted per limit,
      with the behaviour observed rather than the value read back.
- [ ] Retention keeps CR-CRU-129's shipped semantics: unconfigured means NO cap, and the boot
      disclosure still fires naming the uncapped projects and the setting that would bound them.
      This CR moves where its fallback LIVES, not what it does.
- [ ] Configuring one limit changes exactly the behaviour it names: TOON truncation, run
      abandonment, project inactivity, field truncation, error-detail truncation and roadmap list
      length are asserted INDEPENDENTLY, so one setting cannot be wired to another's site.
- [ ] The client settings seam exists once in `clients/_crucible_axi.py` and all five clients
      resolve through it — asserted as a caller count per client, not as "the client resolves it".
- [ ] `--full` still defeats all three display limits per invocation.
- [ ] No test pins a limit VALUE: each configures through the real surface and derives its
      expectation from what it reads back.

**§S1b — the defaults file, editable and documented**
- [ ] `crucible.toml` exists at the repo root with a `[limits]` table holding all six, and every
      entry declares all five fields: `description`, `recommended`, `min`, `max`, `env`. Asserted per
      limit AND as a completeness check over the table, so a seventh limit added without its
      documentation fails rather than shipping undocumented.
- [ ] `description` is a sentence, not a restatement of the key: asserted non-empty and not a bare
      echo of the limit's own name — the rule CR-CRU-128 §S3 established for flag help.
- [ ] The RANGE IS ENFORCED: a configured value below `min` or above `max` is REFUSED at resolution,
      with a message naming the limit, the offending value, the range and the `recommended` setting.
      Asserted per limit, at BOTH ends of BOTH bounds.
- [ ] A refused value is NOT silently clamped: after a refusal the running behaviour is the
      documented fallback and the refusal was reported — proved by observing behaviour, not by
      reading a return value.
- [ ] The enforced bound and the documented bound are THE SAME DATA: the validator reads `min`/`max`
      from the table the operator edits. Asserted by CONSTRUCTION — a test fails if a `min` or `max`
      literal appears anywhere in source, the same scan §S3 extends.
- [ ] `recommended` EQUALS the value the limit resolves to when nothing else is configured, per
      limit — so the documentation cannot recommend one thing while the software does another.
- [ ] Mutation: widening a `max` in the file makes a previously-refused value resolve, and narrowing
      it makes a previously-accepted value refuse. That is the proof the file is the source and not
      a second copy.
- [ ] Both stacks read the SAME file: the server via Bun's native TOML support, the clients via
      `tomllib` — asserted by editing the file once and observing both stacks change.
- [ ] EDITING the file changes behaviour on the next call with NO restart, asserted per stack. A
      static `import` that caches the table fails this.
- [ ] Precedence is asserted as a chain, not per layer: file default < environment variable <
      per-project value. Each step proved to override the one before it, and a missing layer proved
      to fall through rather than to zero.
- [ ] A MALFORMED or absent `crucible.toml` does not crash the server or the clients: it degrades to
      the environment layer and SAYS SO, in the shape CR-CRU-129's boot disclosure established.
      Asserted both ways — absent file, and a file with a syntax error.
- [ ] `docs/RUNBOOK.md` documents all six limits with, per limit: the description, the RECOMMENDED
      setting, the MIN and MAX, the env override and the precedence order — including
      `CRUCIBLE_DEFAULT_RETENTION` and `CRUCIBLE_RUN_ABANDON_MS`, which are operator-configurable
      TODAY and documented NOWHERE.
- [ ] The RUNBOOK's figures are checked against `crucible.toml`, not transcribed from it: a test
      fails if any documented recommended/min/max disagrees with the table. Prose that drifts from
      the data it describes is how `src/hints.ts` came to omit `release` for a month, and a docs
      table is the easiest place in this CR for that to recur.
- [ ] The shipped defaults EQUAL today's compiled values — 65536, 30 min, 1 h, 200, 500, 20 — so
      this CR changes no behaviour until someone edits the file. Asserted per limit, because a
      "configuration" CR that quietly retunes six limits is a different CR.

**§S2**
- [ ] `retention: null` clears the override; the project then inherits the fleet default and a read
      back reports it as inherited rather than as its own.
- [ ] `retention: 0` is accepted and enforced as a cap of zero — the test proves the ROUTE stopped
      refusing what the model accepts, since `enforceRetention`'s `??` already implements it.
- [ ] A negative, fractional or non-numeric value is still refused, and the refusal names what is
      accepted, including `null` and `0`.
- [ ] A PATCH that does not mention `retention` leaves it untouched — `null` and absent are
      distinguishable, proved by patching a different field and re-reading the cap.
- [ ] Mutation: reverting the route to positive-integers-only turns the clear-and-zero tests red.

**§S3**
- [ ] The constructional scan is an EXTENSION of an existing scan, not a third walker — named in the
      implementation.
- [ ] It covers all six resolvers and fails on a reintroduced literal at that `file:line`, proved by
      mutation PER LIMIT.
- [ ] It covers the shared client module as well as the server, since three of the six live there.

**Close-out**
- [ ] ONE re-record of the prose-citation heads and the `src/store.ts` citations after the last
      content edit — currently src 710 / public 477 / clients 836, with `LANDED_STATUSES` at
      `src/store.ts:5784` and `canonical_track` at `:372-375`, each mirrored in
      `clients/_crucible_axi.py`. Not per cycle.

## Estimated size

M — six resolvers, one new client settings seam, a defaults source, one route validator, and an
extension of an existing guard. No migration, no data movement. The seam is the new machinery; the
five other limits are one-line resolutions once it exists.

## Risk

- **A display limit resolving wrongly changes what every agent reads.** The three display limits are
  reached by all five clients on every call. Their configured defaults must equal today's values —
  200, 500, 20 — so this CR is a no-op in behaviour until someone configures otherwise. Assert that
  equality, or the CR silently reformats every agent's output.
- **`TOON_MAX_BYTES` guards an envelope a consumer may size-limit.** Check the five clients and the
  board before changing its default; its current value is a ceiling the truncating loop at
  `src/v2.ts:204` depends on.
- **Clearing an override removes information.** §S2's `null` must be distinguishable from absent.
- **The client seam is the one piece of real machinery here.** If it grows beyond resolving a value
  and its default, it has become a configuration framework and the CR has overreached — the seam
  should be small enough to read in one screen.

## Non-goals

- Retention's own cap, the record tables, the migration or the boot disclosure — CR-CRU-129 owns
  those and shipped.
- The milestone type vocabulary — CR-CRU-130 owns that; it is the same rule applied to a vocabulary
  rather than to a number.
- Making every number in the codebase configurable. The six named here govern what an operator or an
  agent SEES, or how long the server waits. Array bounds, buffer sizes, protocol constants and SQL
  `LIMIT ?` parameters are not limits in this sense.
- Changing any limit's VALUE. This CR moves where the values live; it does not retune them.
