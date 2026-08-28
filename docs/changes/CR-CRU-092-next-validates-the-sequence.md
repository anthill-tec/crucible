# CR-CRU-092 — `next`: the orchestrator validates its sequence during execution

- **Type**: feature
- **Wave**: 5 (0.2.0)
- **Depends on**: 091
- **Status**: PENDING (0.2.0) — moved into 0.2.0 by user direction 2026-08-28
- **Design documents — READ THESE FIRST**: `docs/research/DN-crucible-wave-track-release.md` §"Reading the lane during execution" — the TRACKED model of record for the NEXT / HOLD / DRAINED vocabulary, the trigger kinds, the drained reasons, the oracle-not-scheduler rule and the conditional track rule. The visual it was approved on is `/home/antonyj/Documents/data_projects/crucible/.lavish/crucible-workflow-flowchart.html` §13 (2026-08-28) — absolute path, but `.lavish/` is **gitignored**, so where the two disagree or the flowchart is absent, the DN governs.

> The design document is the contract for this CR. Implement what it specifies — do not
> re-derive the model, the vocabulary or the look from scratch.

## Problem

CR-091 makes the roadmap a declared, ordered dataset. Nothing reads it back during execution.
There is no verb the orchestrator can ask "what is actionable now, and is the declared sequence
still valid against live state" — so mid-flight it re-derives the answer by eye from
`docs/changes/README.md` and the board, and any drift between the declared sequence and live plan
state goes unreported.

The only `next` in reach is the harness's, over a different dataset (its own lane plan), so it
cannot answer this question.

## Scope

`next` is the READ counterpart to CR-091's declarative writes: step 5b of the call chain
(`.lavish/crucible-workflow-flowchart.html` §10), landing in the shared parser so all five clients
gain it at once.

### §S1 The verb does not exist today; the vocabulary does

**Surfaces (verified 2026-08-28):** every subcommand of the fleet is registered per-client with
`sub.add_parser(...)`. `clients/python-crucible.py:1190-1570` is the full list — `register`,
`unregister`, `test`, `regression`, `auto-ingest`, `check`, `pre-merge-gate`, `plan-file`,
`plan-backfill`, `cycle-activate`, `cycle-done`, `cr-close`, `cycle-add`, `checkpoint`, `stop`,
`abort`, `status`/`plans`, `queue`, `gate-run`, `gate-report`, `milestone`, `queue-file`. No
`next`.
`clients/_crucible_axi.py` contains no `add_parser` call at all. A `\bnext\b` scan of all six
files (`bun|python|rust|mvn|arduino-crucible.py` + `_crucible_axi.py`) returns only prose,
comments, `help[]`-template wording and one `next()` builtin (`clients/rust-crucible.py:975`) —
never a subcommand. **`next` is genuinely absent from the fleet.**

The three decision words are borrowed, not invented. `~/.claude/scripts/worktree-flow.py:1041-1080`
(`cmd_next`, subparser at `:1305-1306`) already answers `NEXT` (`:1063`), `HOLD` (`:1075-1080`)
and `DRAINED` (`:1058-1062`) over `schedule_db.next_for_track` (`~/.claude/scripts/schedule_db.py:369-373`),
and already hard-exits when neither `--track` nor `$WF_TRACK` resolves
(`~/.claude/scripts/worktree-flow.py:1055-1056`). This CR adopts that vocabulary verbatim.

Not adopted: the harness's exit codes. `cmd_next` returns `0`/`2`/`3` for NEXT/DRAINED/HOLD
(`:1074`, `:1062`, `:1080`). All three decisions are ANSWERS here, so all three exit `0` — the
fleet's terminal-state rule (`clients/STATUS-CONTRACT.md:65-68`).

### §S2 The three decisions

Input is one read: `GET /api/v2/projects/<key>/queue` (handler `src/v2.ts:1791`, dispatched at `src/v2.ts:2837`), which under
CR-091 publishes `seq` always and `release`/`track` when non-null. Fields are CONSUMED, never
re-derived. The array-index derivation this originally warned against (`seq: index` in
`buildRoadmapGraph`) **no longer exists** — CR-CRU-091 C4 deleted it under that CR's AC18, and the
renderer now consumes the published value (`public/app-logic.mjs:893`). So the rule here is not
"don't copy it" but "don't reintroduce it": `next` orders by the `seq` the read published, and
must handle an ABSENT `release`/`track` key rather than defaulting it. 091 publishes `seq` on every
entry, so an entry without one is a defect to surface, not a hole to fill with a position.

Liveness comes from the same read, and it has **two axes, not one** — the gap-analysis finding
that reshaped this section (2026-08-28, after CR-091 landed).

**Axis 1 — `status`**, server-derived (`src/store.ts:3439-3445` precedence, `deriveQueueStatus` at
`src/store.ts:3730`) as `PENDING` · `IN_PROGRESS` (open plan) · `COMPLETED` (plan closed WITH a
merge) · `COMPLETED_UNTRACKED` (named by a release's `crs`). A CR is **landed** iff its status is
`COMPLETED` or `COMPLETED_UNTRACKED`; anything else is unmerged.

**Axis 2 — `lifecycle`**, present only when declared: `{state: "SUPERSEDED", by}` or
`{state: "VOID", reason}` (CR-091 §S2). It is deliberately **not** a `QueueStatus` member and
**never overrides** the derived status — 091 locked that, and `deriveQueueStatus(projectKey, cr,
shipped)` cannot even see it, by signature. The consequence lands squarely on this verb, which is
the roadmap's first consumer: **a VOID CR with no plan reads `status: "PENDING"`.** A resolution
keyed on `status` alone would therefore return, as the next thing to build, a CR whose author
explicitly recorded that the work is not happening. `status` answers *what happened to the work*;
`lifecycle` answers *whether the work is still wanted*, and `next` must consult both.

A CR is **actionable** iff it is `PENDING` **and** carries no `lifecycle` key. `SUPERSEDED` and
`VOID` entries are excluded from the candidate set exactly as landed ones are — this is not `next`
scanning past a blocked entry (§S4 forbids that), because a dead entry is not blocked work, it is
not work. The distinction is load-bearing: skipping a BLOCKED entry would hide a problem, while
skipping a DEAD one reports the roadmap as authored.

Resolution, over the lane's entries in declared `(release, wave, seq)` order:

| Decision | Condition | Carries |
|---|---|---|
| `NEXT` | the lowest-`seq` ACTIONABLE entry in the lane, every `dependsOn` landed, lane not occupied | `cr`, `seq`, `release`, `wave`, `track`, and a `help[]` template for the call that starts it |
| `HOLD` | that same entry, but blocked | `cr`, `seq`, and `trigger` — the named cause |
| `DRAINED` | no ACTIONABLE entry remains in the lane | `reason`, and the `help[]` for the move that would refill it |

`trigger` is a required object on every `HOLD`, never a prose blob. Exactly one `kind`:

- `in-flight` — the lane already holds an `IN_PROGRESS` entry. Carries that CR id. Evaluated
  FIRST: an occupied lane holds everything behind it.
- `dependency` — one or more `dependsOn` CRs are unmerged and still alive. Carries each blocking
  CR id with its live status. **Reachability, found while building C1's fixtures:** a blocker
  sitting in the SAME lane at a lower `seq` cannot produce this trigger, because that blocker is
  itself the lowest-`seq` actionable entry and the answer there is `NEXT` **on the blocker**. So an
  ordinary `dependency` HOLD is only expressible when the blocker lies OUTSIDE the lane — another
  track, or a wave the lane does not cover. A fixture that puts the blocker behind its dependant in
  one lane is testing nothing, and a resolver that returns `dependency` for it is scanning past the
  front entry, which §S4 forbids.
- `dead-dependency` — a `dependsOn` CR that is `VOID` or `SUPERSEDED`. Carries the dep id, its
  `lifecycle.state`, and its `by` when superseded. **Distinct from `dependency` because it never
  clears by waiting**: a dependency on a dead CR is a roadmap defect the orchestrator must fix by
  re-pointing `dependsOn` (at the successor, for `SUPERSEDED`) or dropping it. CR-091 emits exactly
  this fact at WRITE time as `brokenDependants` (its AC15); this is the READ counterpart, and
  without it a permanently-blocked lane would report `dependency` forever with no hint that waiting
  is futile.
- `unknown-dependency` — a `dependsOn` CR the queue does not hold. Carries the dep id. It cannot
  be shown landed, so it holds; per §12 it is reported, never rejected, and rides a
  structured warning alongside.

`reason` is a required enum on every `DRAINED`: `wave-complete` (the lane held work and all of it
landed **or was declared dead** — a lane whose remaining entries are all `VOID`/`SUPERSEDED` is
complete, and the `help[]` names them so the state is legible rather than mysterious) ·
`awaiting-assignment` (the lane holds no entries, or no `track` is declared yet) ·
`no-roadmap` (the queue read returned zero entries). `next` never emits an empty array or a null
decision as its answer (AXI P5).

### §S3 Track scoping — required only when the data justifies it

`tracks` = the sorted set of distinct non-null `entry.track` values over the entries the queue read
returned. The project is **multi-track** iff `len(tracks) > 1`.

- `len(tracks) <= 1`: `next` takes no argument. It never emits `needs=[track]` and never rides
  `tracks` on the envelope — the flag exists on the parser but is never PROMPTED FOR. This is the
  same conditional rule the swimlanes follow (`.lavish/crucible-workflow-flowchart.html` §7).
- `len(tracks) > 1` and `--track` absent: `ok=false`, `needs=["track"]`, `tracks=[…]` (the live
  list), no `decision` key, **exit 2**. It never picks a lane.
- `--track` naming a value not in `tracks`: `ok=false`, `needs=["track"]`, `tracks=[…]`, exit 2.

**Matching is on the CANONICAL form, so the flag accepts what CR-091's flag accepts.**
Gap-analysis finding, 2026-08-28: 091 stores `track` in the PRD's locked wire format `track-<n>`
and accepts `2`, `track-2` or `Track 2` at the CLI, normalising **server-side** — its clients pass
the spelling verbatim precisely so no client becomes a second decision-maker (091 §S9). `next`
performs **no write**, so no server round-trip exists to normalise its argument, and a naive
by-value match against the stored canonical list would refuse `next --track 2` while
`wave-sequence --track 2` succeeds. One flag, one project, two answers — the exact inconsistency
the fleet standard exists to prevent.

So `next` canonicalises `--track` before comparing, via a **single shared helper in
`clients/_crucible_axi.py`** used by the whole fleet. This does not breach §S9: canonicalising an
input spelling is ARGUMENT PARSING, which §S9 assigns to the client half, whereas 091's rule
governs the WRITE — what gets stored is still decided once, server-side, and `next` stores
nothing. Values in `tracks[]` are echoed as stored (canonical), never re-spelled.

The duplication risk is real and is closed by assertion, not by comment: the two implementations
(TypeScript `normalizeTrack` on the write path, the Python helper on this read path) must agree,
so a test drives each accepted spelling through `wave-sequence`, reads the stored value back, and
asserts the Python helper maps the same input to the same string. A drift between them fails that
test rather than silently splitting one track into two lanes — the failure mode 091 §S2's
normalisation exists to prevent.

Track assignment is CR-091's registered metadata. This CR declares nothing new and writes no
track anywhere.

### §S4 An oracle, not a scheduler

Read-only, like `queue` (`clients/_crucible_axi.py:1185-1226`): no `--agent`, no POST/PATCH, no
`--user-approved`. Two identical consecutive invocations return byte-identical envelopes (modulo
nothing — there is no timestamp in the result fields) and asking does not claim, lock, reserve or
advance anything.

It validates; it does not correct. If the lowest-`seq` `PENDING` entry is blocked, the answer is
`HOLD` on THAT entry with the trigger named. `next` never scans past it to return a later
actionable CR, and never re-orders the lane — that would be Crucible substituting a sequence of its
own, which the write path already refuses (`src/v2.ts:1805`, `src/v2.ts:2017`: unknown deps are "flagged in
`unknownDependencies`, never rejected") and which §12 forbids on both paths.

### §S5 Two `next`s, never reconciled

`worktree-flow next` reads the harness ChangeSet DB (`~/.claude/scripts/schedule_db.py:26-27` —
`.wf-schedule.db`, legacy `.nai-schedule.db`; opened via `~/.claude/scripts/worktree-flow.py:100-111`). This verb
reads the declared roadmap over HTTP. They answer different questions; a disagreement is a real
signal that the lane plan has drifted, and is left visible.

No code path in `clients/` may open, read, import or shell out to that DB, `schedule_db`, or
`worktree-flow.py`. No fallback, no cross-check, no merge of the two answers.

### §S6 AXI envelope

Reuse the fleet emitter — `emit_axi` (`clients/_crucible_axi.py:220-229`: TOON envelope on stdout,
human line on stderr), dispatched through `run_verb` (`:955-973`). No hand-rolled output.

`help[]` is STATE-DERIVED, per CR-CRU-048's rule as stated at `clients/_crucible_axi.py:710-714`
("Never a canned per-verb string"). `next` gets **no** entry in `HELP_STEPS`
(`clients/_crucible_axi.py:616-629`); each decision derives its own:

- `NEXT` → the concrete start call, e.g. `plan-file --cr <cr> --title "…" --cycles "…" --wave <wave>`
  (flags verified at `clients/python-crucible.py:1349-1362`).
- `HOLD` → the move that clears the named trigger (the blocking CR's `cr-merged`/`cr-close`, or
  `cr-plan` for an unknown dep), then `next` again.
- `DRAINED` → `wave-sequence` for `awaiting-assignment`, `release-propose` → `cr-plan` →
  `wave-sequence` for `no-roadmap`.

Exit codes: `0` any decision returned · `2` usage (§S3), the same class as
`emit_agent_identity_hard_stop` (`clients/_crucible_axi.py:944-952`) · `1` the queue read failed.
A failed read is NEVER reported as `DRAINED` — an unreadable roadmap and an empty one are
different facts.

Registered in ALL FIVE clients, like `queue` (`clients/python-crucible.py:1437-1440`, and one
registration in each of bun/rust/mvn/arduino — verified). `queue-file` is in 1 of 5
(`clients/python-crucible.py:1548-1556`); this verb must not repeat that gap. CR-CRU-075 owns
`queue-file`'s parity and the census-enforcement mechanism; `next` lands at parity on arrival and
is subject to that census, not an exception to it.

**Full AXI conformance (P1–P10), stated per principle.** The fleet standard is a standing user
requirement (2026-07-21), so `next` is measured against the whole of it — and where a principle
does not apply to a single-decision verb, that is **declared here** rather than silently skipped.
A faked `--full` on a one-record answer is as wrong as a missing one.

| P | How `next` satisfies it |
|---|---|
| P1 | TOON envelope on stdout via `emit_axi`; human line to stderr only. |
| P2 | `--fields` narrows the envelope, the fleet's existing selection. |
| P3 | **N/A by shape** — the answer is ONE decision, never a truncated list. `--full` is not added, because there is nothing it could reveal. |
| P4 | `totalCount` on `tracks[]` in the multi-track refusal (§S3) — the verb's only list. |
| P5 | `DRAINED` is the definitive empty state: a decision, never a blank (§S5). |
| P6 | Structured error on **stdout**, exit `0`/`1`/`2` per AC13; read-only, so idempotency is free (§S4). |
| P7 | The `context` block `emit_axi` always writes, carrying the resolved lane. |
| P8 | Bare `next` in a single-track project answers with live data, no flags required (§S3). |
| P9 | `help[]` is state-derived per decision, never canned (above). |
| P10 | `--help` exits 0 and lists the verb in all five clients (AC12). |

## Acceptance criteria

- **AC1** — **`NEXT` names the CR and its `seq`.** For a lane whose lowest-`seq` `PENDING` entry
  has all `dependsOn` landed, the envelope carries `decision="NEXT"`, `cr=<that id>`, and `seq`
  equal to the integer the queue read published for it. A `seq` derived from the entries' array
  index fails this AC (fixture: the lane's first entry has `seq` ≠ 0).
- **AC2** — **`NEXT` carries a start template.** `help[0]` contains `plan-file --cr <that cr>` with
  the entry's own `wave`. An empty `help[]`, or the `HELP_STEPS` canned string, fails.
- **AC3** — **`HOLD` without a named trigger FAILS.** Every `decision="HOLD"` envelope carries
  `trigger` with a `kind` in `{in-flight, dependency, dead-dependency, unknown-dependency}` AND at least one named
  CR id. A `HOLD` with `trigger` absent, null, empty, or containing no CR id fails this AC.
- **AC4** — **the three trigger kinds are distinguished.** Three fixtures: (a) the lane holds an
  `IN_PROGRESS` entry → `kind="in-flight"` naming it; (b) the target's `dependsOn` names a
  `PENDING` queued CR → `kind="dependency"` naming that CR with `status="PENDING"`; (c) the
  target's `dependsOn` names a CR absent from the queue → `kind="unknown-dependency"` naming the
  dep, plus a structured `warnings[]` entry. Fixture (a) with a blocked dependency ALSO present
  returns `kind="in-flight"` — the occupancy check runs first.
- **AC5** — **`HOLD`, not a skip.** Fixture: lane = `[A seq 1 PENDING deps:[Z], B seq 2 PENDING
  deps:[]]`, `Z` unmerged. The answer is `HOLD` on `A`. An envelope naming `B`, or any
  `decision="NEXT"`, fails this AC.
- **AC6** — **`DRAINED` renders an explicit reason.** Every `decision="DRAINED"` carries `reason`
  in `{wave-complete, awaiting-assignment, no-roadmap}` and a non-empty `help[]`. Three fixtures
  produce the three reasons: all lane entries landed → `wave-complete`; queue non-empty but the
  lane holds no entries → `awaiting-assignment`; queue read returns `entries: []` →
  `no-roadmap`. A bare empty list, a null `cr` with no `reason`, or an absent `reason` fails.
- **AC7** — **multi-track, `--track` omitted → exit 2 and the tracks are listed.** Fixture: queue
  entries carrying two distinct `track` values. `next` with no flag exits **2**, `ok=false`,
  `needs=["track"]`, `tracks` equal to the sorted distinct live values, and **no `decision` key**.
  An envelope carrying a decision fails this AC.
- **AC8** — **single-track accepts `next` with no flag.** Fixture: every entry carrying the same
  `track`, and a second fixture with no `track` key on any entry. Both exit 0 with a decision,
  `needs` absent, and **no `tracks` key** on the envelope. An unknown `--track` value in a
  multi-track fixture exits 2 with the live `tracks` list.
- **AC9** — **idempotent oracle, and it mutates nothing.** Two identical consecutive invocations
  produce byte-identical stdout. Across both, the client issues **zero** non-GET HTTP requests
  (asserted on the request log of the stubbed transport), and re-reading the queue afterwards
  yields an unchanged entry set — same ids, same `seq`, same `status`. A single POST/PATCH/PUT
  fails this AC.
- **AC10** — **no `--agent`, no identity gate.** `next --help` declares no `--agent` flag, and the
  verb returns a decision with `$CRUCIBLE_AGENT_ID` unset and no `--agent` passed — it never routes
  through `emit_agent_identity_hard_stop`.
- **AC11** — **the harness DB is untouched.** A grep over `clients/` returns zero matches for
  `schedule_db`, `.wf-schedule.db`, `.nai-schedule.db`, `next_for_track` and `worktree-flow`. A
  behavioural companion: with a populated `.wf-schedule.db` present at the project root whose lane
  plan names a DIFFERENT CR than the declared roadmap does, `next` returns the ROADMAP's answer
  unchanged and emits no warning about the discrepancy.
- **AC12** — **the verb exists in all five clients.** `<stack>-crucible.py next --help` exits 0 for
  every one of `bun`, `python`, `rust`, `mvn`, `arduino`, and each is registered exactly once. The
  fleet census harness (`tests/client/test_client_fleet_envelope_census.py:82-90`, `:486-523`)
  reports a real `next` envelope for all five — zero bare.
- **AC13** — **envelope + exit codes.** Every path emits through `emit_axi`, so stdout parses as a
  TOON `axi` envelope with `verb="next"` and the human line lands on stderr only. Exit codes:
  `NEXT`/`HOLD`/`DRAINED` → 0; missing/unknown `--track` in a multi-track project → 2; a queue GET
  that returns non-ok → **1** with `ok=false` and a structured warning naming the read failure, and
  **no** `decision` key. A failed read reported as `DRAINED` fails this AC.
- **AC14** — **fields are consumed, not re-derived.** Fixture whose queue entries carry `seq`
  values `[10, 20, 30]`, a `release` key on only some entries, and `track` on only some. The
  envelope echoes `seq`/`release`/`wave`/`track` verbatim for the CR it names, OMITS `release` and
  `track` for an entry that declares neither, and never substitutes an index, the wave, or the CR
  id for `seq`.
- **AC15** — **AXI conformance is asserted, per principle (§S6).** Extends the two EXISTING
  harnesses rather than adding a parallel checker: `tests/client/test_client_fleet_envelope_census.py`
  for envelope conformance, and `tests/client/test_cr054_fleet_inventory.py` for `next`'s presence
  in the frozen fleet set (whose count CR-CRU-075 moves to 49).
  For each of the five clients: `--fields` narrows the envelope (P2); the multi-track refusal
  carries `totalCount` on `tracks[]` matching its length (P4); the envelope always carries a
  `context` block (P7); a bare `next` in a single-track project answers with live data and no flags
  (P8); `--help` exits 0 (P10); and **no `--full` flag exists** — P3 is declared N/A because the
  answer is one decision, so a `--full` that reveals nothing is a conformance failure, not a
  courtesy. Every error path writes its structured envelope to stdout, never prose to stderr (P6).
- **AC16** — **a dead CR is never offered as work.** Fixture: a lane whose lowest-`seq` entry is
  `PENDING` and carries `lifecycle.state = "VOID"`, with an actionable `PENDING` entry behind it.
  `next` returns `NEXT` naming the SECOND entry, never the voided one. Same fixture with
  `SUPERSEDED` (carrying `by`) behaves identically. A resolution keyed on `status` alone returns
  the dead CR and fails this AC — and that is the pre-fix behaviour, so the test must be shown
  failing against a `status`-only resolver. With EVERY remaining entry in the lane dead, the answer
  is `DRAINED` with `reason="wave-complete"` and a `help[]` naming the dead CRs — never `NEXT` on a
  corpse and never a blank.
- **AC17** — **a dependency on a dead CR reports `dead-dependency`, not `dependency`.** Fixture:
  `CR-B` depends on `CR-A`; `CR-A` is `PENDING` and `VOID`. `next` returns `HOLD` on `CR-B` with
  `trigger.kind === "dead-dependency"`, carrying `CR-A` and its `lifecycle.state`. With `CR-A`
  `SUPERSEDED` the trigger also carries its `by`. A `HOLD` reporting `kind: "dependency"` for a
  dead blocker fails this AC: `dependency` promises that waiting resolves it, and waiting on a
  voided CR never does.
- **AC18** — **`next --track` accepts every spelling `wave-sequence --track` accepts, and the two
  normalisers agree.** With one track stored, `next --track 2`, `--track track-2` and
  `--track "Track 2"` all resolve to the same lane and return the same decision; a value carrying
  no integer is refused by name. `tracks[]` echoes the STORED canonical value, never the caller's
  spelling. Cross-implementation: for each accepted spelling, the value `wave-sequence` causes the
  server to store equals the value the shared Python helper produces — a divergence between
  `normalizeTrack` (TypeScript, write path) and the client helper (read path) fails this AC.

  **Toolchain dependency, decided 2026-08-28.** The cross-implementation half needs a real server,
  so it boots a scratch one (free port, `mkdtemp` DB) and drives the actual write path. Where `bun`
  is absent the class raises `SkipTest` with a message stating that AC18's cross-implementation
  half is NOT proven, rather than passing silently. That is the right trade: CR-CRU-066 §S2 makes
  Bun a GUARANTEED install dependency — the `server` stage detects it, bootstraps it when absent
  and fails the install with a named remedy otherwise — so its absence means a broken install, not
  a legitimate lean environment, and a loud skip names that. A hard failure would punish a
  deliberately minimal checkout for a condition the installer already guarantees. Every other test
  in the file is pure and needs no toolchain. A source-text guard on `store.ts` was the first
  attempt and was DELETED when this landed: it would break on a harmless refactor and pass while
  the surrounding logic changed.

## Estimated size

M — one read verb in the shared parser plus five thin registrations; the substance is the decision
resolver (lane selection, occupancy, dependency landing, three trigger kinds, three drained
reasons) and its fixtures.

## Risk

The decision resolver reads a dataset CR-091 has just started writing, so a lane with no `track`
declared and a lane with one track are the same shape on the wire. AC8 pins both to the same
answer so the ambiguity cannot become a silent `needs=[track]` on a single-track project.

`unknown-dependency` holds the lane. A roadmap authored forwards — legal and expected during
design (`src/v2.ts:1805`, `src/v2.ts:2017`) — therefore reads back as `HOLD` until the dep is authored. That is
the honest answer, but it means a forward-referencing roadmap looks stalled; the trigger names the
missing id and `help[]` names `cr-plan`, which is the whole remedy.

## Non-goals

- Reconciling with `worktree-flow next` — §S5. Neither side adjusts to the other, and the drift is
  not repaired here.
- Claiming, locking or assigning a CR; advancing any state — `next` is read-only (§S4). The start
  call stays `plan-file`, invoked by the orchestrator.
- Writing `track`, `seq`, `release` or wave membership — all CR-091's.
- Re-ordering, re-sequencing or repairing a declared sequence, and hard-refusing a dependency
  cycle — the write path's severities (§12), owned by CR-091.
- Exposing `next` on the server as an endpoint. The server stays plain functional REST; the
  decision is client-side, per the division of labour in
  `.lavish/crucible-workflow-flowchart.html` §10.
- Forecasting when a `HOLD` will clear — CR-CRU-022, deferred.
- Building the verb-surface census mechanism, or fixing `queue-file`'s 1-of-5 parity — CR-CRU-075.
  AC12 asserts `next`'s own parity against the existing census harness; it adds no enforcement.
