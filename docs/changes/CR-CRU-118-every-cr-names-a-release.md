# CR-CRU-118 — every live CR names a release, and every release names its target date

- **Type**: feature
- **Wave**: 6 (0.2.0)
- **Depends on**: 091, 099, 104
- **Status**: PENDING (0.2.0)
- **Design reference**: `docs/research/DN-crucible-wave-track-release.md` — the drift section's **D4**
  (every live CR names a release; every release proposal names its target date) and "A CR can be BORN
  mid-release", both user-ruled 2026-09-10

## Context

Measured on the live board 2026-09-10, after the user caught `CR-CRU-117` scheduled but undrawable.

**The inconsistency.** `declareMembership` enforces every rule about a release a CR DOES name — the
label's shape, and that it names a live proposal or a recorded release, the rule CR-CRU-104 added "so
a migration could store membership in a release nobody proposed". It has nothing to say about naming
**none**. Absence bypasses the only gate there is, and because roadmap zone 2 is release-scoped, the
result is a CR the scheduler offers and the roadmap cannot draw. `next` answered `NEXT cr=CR-CRU-117`
while that CR appeared on no roadmap surface.

**Three measured facts this CR is built on:**

1. **67 queue entries carry no release**: 62 landed 0.1.0-era rows (history — their provenance lives
   on the release record's own `crs` set) and **5 live ones** — `015`, `018`, `022`, `098` in wave 7,
   plus `082`, VOID.
2. **The bulk queue route cannot carry membership.** `parse_queue_table` returns
   `{cr, title, wave, dependsOn}` and never reads the release qualifier the table itself prints
   (`PENDING (0.2.0)`, `6 (0.2.0)`). So a bootstrap re-post of the queue file publishes a wave and
   drops the release — which is how `CR-CRU-117` reached the board unauthored. This is the SECOND
   recorded loss from that route: `082`'s own stored lifecycle reason reads "disposition was lost when
   the board was cleared and repopulated via queue-file on 2026-08-29, which imports rows but not
   lifecycle dispositions".
3. **`targetAt` already exists and is optional.** CR-CRU-091 §S1 gave a `release-proposal` a declared
   target in epoch seconds — the same unit as `releasedAt`, distinguished as "when it was aimed for"
   vs "when it shipped" — and `recordReleaseProposal(…, { label, targetAt? })` accepts its absence.
   The live `0.2.0` proposal carried none until this CR's own gap analysis set one.

**Surfaces:** `declareMembership`, `handleQueuePost`, `handleCrPlan`, `defaultedSeqWarnings` and the
`QueueWarning` code union in `src/v2.ts`; `recordReleaseProposal` in `src/store.ts`;
`parse_queue_table`, `cmd_queue_file`, `cmd_cr_plan`, `cmd_release_propose` in
`clients/_crucible_axi.py` plus the five clients' `release-propose` and `queue-file` wrappers.

## Scope

### §S1 A live CR without a release is refused

`cr-plan` and the per-CR declaration path refuse a CR whose release is absent, by field name, with
the proposals route in `help[]` — the shape `declareMembership` already uses for a release nobody
proposed. Refused BEFORE any write: nothing is stored, nothing half-declared.

A CR born mid-release names the release already in flight (D4's second half). The rule is "name a
release", never "name it before the branch was cut" — this project's own 0.2.0 grew a whole second
wave on its release branch.

### §S2 The bulk route refuses what it would INVENT, and warns about what it inherits

The bulk queue POST is the bootstrap: it re-posts the whole table, including rows whose release is
legitimately still unassigned until a migration runs. So it splits by what the write actually does:

- an entry the route **inserts** with no release is **refused** — that is a new CR arriving
  membership-less, exactly the `CR-CRU-117` case;
- an entry that **already exists** with no release keeps `replaceQueue`'s carry-forward and raises a
  **warning naming those crs** — a migration list that shrinks to zero, not a wall.

The warning is a fifth `QueueWarning` code, structured like `defaulted-seq` (a `message` for the five
clients to print and `crs[]` for a machine), because §S9 says a client renders findings and decides
nothing.

### §S3 The bulk route carries the membership the table declares

`parse_queue_table` reads the release qualifier already printed in the Status and Wave cells and
sends it. The parser stops dropping data the file states, which is the actual cause of §S2's refusal
case ever arising, and closes the second half of the `queue-file` defect class.

Nothing is inferred: a cell with no qualifier sends no release, and the §S2 rung decides what happens
next.

### §S4 A release proposal declares its target date

`targetAt` becomes required: `release-propose` without `--target` is refused client-side by argparse
and server-side by the route, and `recordReleaseProposal`'s signature stops treating it as optional.
The revision semantics are untouched — a moved target retires its predecessor and inserts a new row,
so slippage stays auditable, which is the property burn-down will later read.

### §S5 The envelope says what was refused, and why

Every refusal names the field, the CR, and the move that fixes it (`release-propose` for a missing
release, `--target` for a missing date). No refusal is a bare 400.

## Acceptance criteria

**§S1 — membership is mandatory**

- [ ] `cr-plan` with no `--release` is refused; the store wrote nothing (asserted by re-reading the
      queue, not by trusting the response).
- [ ] The refusal's `help[]` names the `release-proposals` route, matching the existing
      no-such-proposal refusal's shape.
- [ ] A CR declared into the release currently IN FLIGHT succeeds — the mid-release-birth case, driven
      on a board whose proposal is live and whose branch is cut. This is the mode 0.2.0 itself ran in.
- [ ] A CR declared into a label with no live proposal and no recorded release is still refused with
      today's message — this CR narrows absence, and changes no existing refusal.

**§S2 — the bulk route**

- [ ] A bulk post containing a CR the board does NOT hold, with no release, is refused by CR id and
      index; `listQueue` is unchanged afterwards.
- [ ] A bulk post whose release-less entries all ALREADY exist writes, and returns a warning whose
      `crs[]` names exactly those entries — asserted against the live shape: five today
      (`015`, `018`, `022`, `098`, `082`).
- [ ] The warning's `code` is the fifth member of the union, and the union's OTHER four are asserted
      unchanged by length and by value.
- [ ] The 62 landed 0.1.0-era rows produce the warning, never a refusal, and are not rewritten — a
      bootstrap of today's file must still succeed.

**§S3 — the parser carries membership**

- [ ] A table row reading `COMPLETED (0.2.0)` / `6 (0.2.0)` sends `release: "0.2.0"`; a row with no
      qualifier sends no `release` key at all (absence by key, not empty string).
- [ ] Round trip: posting the project's own `docs/changes/README.md` preserves every release
      assignment on the board — asserted by comparing the full `{cr: release}` map before and after,
      which is the regression the `CR-CRU-117` incident actually needs.
- [ ] A qualifier the table states is sent VERBATIM — no normalisation, no `v` stripping — mirroring
      `declareMembership`'s "nothing is COERCED on the way in".

**§S4 — the target date**

- [ ] `release-propose` without `--target` is refused by argparse in all five clients, asserted per
      client, with the client count itself asserted (5).
- [ ] The route refuses a proposal with no `targetAt` even when a client is bypassed — the rule lives
      server-side, not only in the flag surface.
- [ ] An ISO date and an epoch-seconds value both land the same stored integer.
- [ ] A revision with a NEW target retires the predecessor and inserts a new row: the retired row is
      still readable by id, and `listReleaseProposals` returns exactly one live proposal for the label.
      Asserted because this is the property burn-down depends on.
- [ ] Re-proposing the SAME label with the SAME target still converges (`changed: false`, nothing
      written) — CR-CRU-091's AC12 idempotence survives the mandate.

**Integration**

- [ ] All five clients expose `--target` on `release-propose` and refuse its absence, asserted per
      client.
- [ ] The five LIVE release-less entries are unaffected by this CR's code: their migration into
      `0.3.0` is a DATA step, scheduled after 0.2.0 ships (user-ruled 2026-09-10), and no AC here
      performs it.

## Estimated size

Two cycles. §S1+§S2 (the refusal rungs and the fifth warning code) then §S3+§S4 (the parser and the
mandatory target across the fleet).

## Risk

- **This CR refuses input that is legal today**, so a mistake blocks the bootstrap the whole board is
  restored from. §S2's split exists precisely for that: refuse what the route would INVENT, warn about
  what it inherits, so today's file keeps posting until the migration clears the five.
- **The 62 landed rows must never be refused or rewritten.** Their provenance lives on the 0.1.0
  release record; touching them would rewrite shipped history for a rule about live work.
- Making `targetAt` mandatory changes an existing route's contract. Every caller is in this repo (the
  five clients plus tests), and the ACs assert the refusal server-side as well as in argparse so a
  future caller cannot slip past the flag.
- A date is an ESTIMATE. Nothing in this CR treats a passed target as a failure — that judgement
  belongs to the analytics that are deliberately out of scope.

## Non-goals

- **No burn-down, velocity or forecast computation** (user-stated 2026-09-10). This CR makes the axis
  exist and keeps its history honest; reading it is later work.
- **No retroactive repair** of the 62 landed rows, and no migration of the five live ones — that is a
  dated data step after 0.2.0 ships.
- No new record kind, no new route, no schema change: `declareMembership`, `targetAt` and
  `QueueWarning` all already exist.
- No change to wave semantics, to `next`'s vocabulary, or to how a release is recorded.
