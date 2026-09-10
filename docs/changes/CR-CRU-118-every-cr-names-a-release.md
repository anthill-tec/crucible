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
4. **The per-CR door is already shut, so the mandate is narrower than it first looked.**
   `handleCrPlan` answers `400 RELEASE_REQUIRED` and `handleWaveSequence` requires `release` too;
   client-side the shared registrar's `--release` help states the ask-don't-guess behaviour. Only the
   BULK writer accepts absence — which is exactly where both incidents came from.
5. **One flag surface per verb, fleet-wide, by construction.** `add_roadmap_verbs`,
   `add_queue_file_verb`, `add_next_verb`, `add_cr_depends_verb` and `add_tier_verbs` each build their
   subparsers ONCE in `clients/_crucible_axi.py`, injecting only `funcs` / `parents` / `add_args` per
   client. So every surface change here is one line reaching five clients, and the fleet obligation is
   a parity CENSUS (CR-CRU-075's pattern) rather than five edits.

**Surfaces:** `declareMembership`, `handleQueuePost`, `handleCrPlan`, `defaultedSeqWarnings` and the
`QueueWarning` code union in `src/v2.ts`; `recordReleaseProposal` in `src/store.ts`;
`parse_queue_table`, `cmd_queue_file`, `cmd_cr_plan`, `cmd_release_propose` in
`clients/_crucible_axi.py` plus the five clients' `release-propose` and `queue-file` wrappers.

## Scope

### §S1 The per-CR door is ALREADY closed — this CR keeps it closed and closes the others

**Rescoped 2026-09-10 after measurement, and the correction is worth stating plainly: most of what
this section originally demanded is already shipped.** `handleCrPlan` refuses an absent release
server-side (`400`, `RELEASE_REQUIRED`), `handleWaveSequence` requires one too, and client-side the
shared registrar declares `--release` as *"Undeclared → the client lists the live proposals and exits
2"* — CR-CRU-091 §S6's ask-don't-guess rung. So a CR declared through the per-CR verbs has never been
able to arrive membership-less.

What this CR therefore does with §S1 is **assert that as a regression** rather than build it: both
halves (the server refusal and the client's ask) must still hold afterwards, because §S3a is about to
widen the set of acceptable labels and a widening is exactly how a requiredness rule gets lost.

The mandate's actual teeth land where the hole measurably is:

- the **bulk door** (§S2), the only writer that accepts a release-less entry;
- a **board-level invariant** — no LIVE queue entry lacks a release — asserted as a census, so the
  rule is checked against the whole board and not only at the moment of writing;
- the **historical door** (§S3a), without which the invariant is unreachable for 62 landed rows.

A CR born mid-release names the release already in flight (D4's second half). The rule is "name a
release", never "name it before the branch was cut" — this project's own 0.2.0 grew a whole second
wave on its release branch.

### §S1a One flag surface, five clients — by construction, not by five edits

Every verb this CR touches is registered ONCE in `clients/_crucible_axi.py` and reaches the fleet
through three injected per-client pieces (`funcs`, `parents`, `add_args`):

| verb | registrar | what changes here |
|---|---|---|
| `release-propose` | `add_roadmap_verbs` | `--target` becomes required — ONE line |
| `cr-plan` | `add_roadmap_verbs` | unchanged (already requires `--release`) |
| `wave-sequence` | `add_roadmap_verbs` | unchanged (already `required=True`) |
| `queue-file` | `add_queue_file_verb` | gains the deprecation warning — ONE site |

So the fleet-wide obligation is a PARITY GUARD, not five parallel edits: the ACs drive every client's
real `--help` as a subprocess and assert the client count itself, which is CR-CRU-075's own census
pattern. A change that forked one client's surface would fail those, and a change that reached only
the shared module without the census would pass silently — which is the failure mode CR-CRU-075
exists to prevent ("one verb was an envelope on one stack and argparse's `invalid choice` on four").

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

### §S3 The bulk route announces that it is deprecated

**Rescoped 2026-09-10, user-agreed.** This section used to teach `parse_queue_table` to carry the
release qualifier the table prints. It is dropped: `queue-file` is a TRANSITIONAL door being retired
(DN D4's fallout §1), and building membership parsing into it would make a corpse comfortable rather
than force its replacement to exist. §S2's refusal already stops another `CR-CRU-117`.

Instead the route says what it is: every call raises a deprecation warning naming the per-CR verbs
that replace it — `cr-plan`, `cr-depends`, `wave-sequence` — in the same structured shape as every
other finding, so five clients render it and none of them decides anything.

Removal, plus a file-driven sync that issues those per-CR calls, is 0.3.0 work and not this CR's.

### §S3a Historical membership is a derivation, not a plan

Measured: `declareMembership` accepts only labels holding a LIVE proposal, so a landed CR cannot be
told which SHIPPED release it belonged to — `cr-plan --release 0.1.0` answers `404 … no live
proposal`, by design, because a shipped release's proposal is consumed by its own insert.

Without a second door the mandate cannot close: 62 landed rows carry no release and no gated verb can
give them one. The door, narrow by construction: **a declared label naming a RECORDED release is
accepted only where that release's own `crs` set already names the CR.** A derivation from settled
fact, self-checking — it cannot add scope to a closed release, because the release must already claim
the CR itself.

Measured coverage: all 62 are named by a recorded release (`0.1.0` → 60, `0.1.2` → 1, `0.1.3` → 1).
Zero not derivable. The backfill itself is a DATA step that runs once this ships.

### §S4 A release proposal declares its target date

`targetAt` becomes required: `release-propose` without `--target` is refused client-side by argparse
and server-side by the route, and `recordReleaseProposal`'s signature stops treating it as optional.
The revision semantics are untouched — a moved target retires its predecessor and inserts a new row,
so slippage stays auditable, which is the property burn-down will later read.

### §S5 The envelope says what was refused, and why

Every refusal names the field, the CR, and the move that fixes it (`release-propose` for a missing
release, `--target` for a missing date). No refusal is a bare 400.

## Acceptance criteria

**§S1 — membership is mandatory (regression + the board invariant)**

- [ ] `cr-plan` with no `--release` is still refused server-side; the store wrote nothing (asserted by
      re-reading the queue, not by trusting the response). Already true — asserted so §S3a's widening
      cannot lose it.
- [ ] The client still ASKS rather than guesses when `--release` is omitted: it lists the live
      proposals and exits 2 (CR-CRU-091 §S6), unchanged in all five clients.
- [ ] The refusal's `help[]` names the `release-proposals` route, matching the existing
      no-such-proposal refusal's shape.
- [ ] **Board invariant, asserted as a census**: no LIVE (non-landed, non-dead) queue entry lacks a
      release. Measured against the live board, so the rule is checked over the whole set rather than
      only at the write. Today this census FAILS with exactly five names
      (`015`, `018`, `022`, `098`, `082`) — it is the migration's own progress meter, and it passes
      when the data step completes.
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

**§S3 — the deprecation notice**

- [ ] Every `queue-file` call raises a deprecation warning, on a SUCCEEDING call as well as a failing
      one — a warning only the failure path emits would be invisible exactly when the route is being
      used as intended.
- [ ] The warning names the three replacement verbs by name, machine-readably, and is structured like
      every other finding (`code`, `message`) rather than prose a client must parse.
- [ ] It reaches all five clients, asserted per client, with the client count itself asserted (5).
- [ ] The route still WORKS: deprecated is not removed, and a bootstrap of today's file still
      succeeds (with §S2's warning for the inherited release-less rows).

**§S3a — historical membership**

- [ ] `cr-plan --release 0.1.0` for a CR the `0.1.0` release record NAMES in its `crs` succeeds, and
      the queue row comes back carrying that release.
- [ ] The same call for a CR the record does NOT name is refused — the derivation's self-check, and
      the assertion that this door cannot add scope to a shipped release.
- [ ] A label that is neither a live proposal nor a recorded release keeps today's exact refusal
      (`no live proposal — it is not a plannable target`): this CR adds a door, it widens no existing
      one.
- [ ] A live proposal still takes precedence unchanged — an in-flight release is planned into exactly
      as it is today, with no `crs` membership required (it has shipped nothing yet).
- [ ] All 62 landed release-less rows are derivable: asserted as a census against the live board, so
      the migration's precondition is a measured fact rather than an assumption.

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
      client, with the client count itself asserted (5) — the parity guard, since the change itself is
      one line in `add_roadmap_verbs`.
- [ ] The four verbs' flag surfaces are IDENTICAL across the five clients, driven from each client's
      real `--help`: `release-propose`, `cr-plan`, `wave-sequence`, `queue-file`. A fork in any one of
      them fails, which is what makes the single-registrar design a fact rather than an intention.
- [ ] The five LIVE release-less entries are unaffected by this CR's code: their migration into
      `0.3.0` is a DATA step, scheduled after 0.2.0 ships (user-ruled 2026-09-10), and no AC here
      performs it.
- [ ] The 62 landed rows' backfill is likewise a DATA step, run through `cr-plan` once §S3a ships —
      not an AC, and never a direct database edit.

## Estimated size

Three cycles. §S1+§S2 (the refusal rungs and the fifth warning code), §S3+§S3a (the deprecation notice
and the historical-membership door), §S4 (the mandatory target across the fleet).

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
  exist and keeps its history honest; reading it is later work — and it is already SPECIFIED:
  CR-CRU-022 §S4 consumes the declared target and computes
  `scheduleHealth: ahead|at-risk|behind`, having already retired a competing `queue-file`-owned
  per-wave `targetDate` "before it was built, because two target-date mechanisms on one board would
  have to be reconciled and one of them would be wrong". This CR feeds that spec; it does not
  anticipate it.
- **No removal of `queue-file`**, and no file-driven replacement sync: deprecation warns here,
  removal plus the sync is 0.3.0 work (DN D4 fallout §1). CR-CRU-075's fleet-parity tests — which
  assert every client MUST expose the verb — invert at removal, not here.
- **No re-base of CR-CRU-022's scope source.** Its burn-down currently derives snapshots from
  `POST /queue` being called twice; the bulk route's retirement takes that with it, and the re-base
  is recorded in the DN as design work for that CR, not smuggled in here.
- **No retroactive repair** of the 62 landed rows, and no migration of the five live ones — that is a
  dated data step after 0.2.0 ships.
- No new record kind, no new route, no schema change: `declareMembership`, `targetAt` and
  `QueueWarning` all already exist.
- No change to wave semantics, to `next`'s vocabulary, or to how a release is recorded.
