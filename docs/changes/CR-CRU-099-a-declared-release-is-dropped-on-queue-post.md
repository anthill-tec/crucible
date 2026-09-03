# CR-CRU-099 — a declared release is dropped on queue post

- **Type**: bug
- **Wave**: 5 (0.2.0) — release membership is the user's call
- **Depends on**: none — the fix is local to one request handler
- **Status**: COMPLETED (0.2.0) — filed 2026-09-02, gap-analysed and corrected 2026-09-03, shipped 2026-09-03
- **Found by**: CR-CRU-096's VERIFY cycle, running an e2e scenario no cycle had run

## Problem

`POST /api/v2/projects/<key>/queue` accepts a `release` field, answers `200`, and **silently
discards it**. `handleQueuePost` builds its `QueueEntryInput` from `cr/title/wave/dependsOn/size/seq`
(`src/v2.ts:1865-1876`) and never reads `fields.release`, so the row is stored with no release and
the subsequent `GET .../queue` answers it release-less.

`git log -S"fields.release" -- src/v2.ts` is **empty**. It has never been read — not since
CR-CRU-078 rewrote the roadmap e2e scenario to declare one.

This is not a rendering defect. The write path loses authored data.

**This reverses a deliberate CR-CRU-091 boundary, and says so.** CR-CRU-091 §S8 (`:322`) declares
the per-entry `seq` *"the one wire addition beyond the five-route table"* — release, track and
lifecycle were routed through the five per-CR verbs on purpose, and `docs/changes/README.md:186-194`
records the resulting store surface as a **note, not a defect**. What changed is CR-CRU-078
rewriting the e2e scenario to declare a release **through this route**, which turns a deliberate
boundary into a dropped write. The boundary is being moved, not repaired.

**Three fields are dropped, not one.** `QueueEntryInput` declares `release?`, `track?` and
`lifecycle?` (`src/store.ts:283-287`); the handler reads none of them. Fixing only `release` would
leave §S2's guard permanently red or force an exemption list, so all three are wired — see §S1.

**Carry-forward is why this is invisible on the live board.** `replaceQueue` stores
`entry.release ?? snapshot?.release ?? null` (`src/store.ts:3599-3601`), so a re-post of an existing
row preserves the release `cr-plan` set. The loss lands only on rows the bulk post **creates** —
which is exactly the e2e scenario, and exactly a fresh board.

## Why nothing caught it

`tests/e2e/features/roadmap-graph.feature:38` posts a CR declaring release `0.2.0` through this
route (`tests/e2e/steps/roadmap-graph.steps.ts:65-66`), and lines `41-46` then expect zone 2 to draw
its wave box. It fails at `tests/e2e/steps/roadmap-graph.steps.ts:83` — and fails **identically at
CR-CRU-096's merge-base**, so it is a standing failure, not a regression.

**It went unnoticed because a per-cycle AC cited a release-tier consumer.** The e2e suite is not
missing a gate: `test-e2e` is a job in the release workflow (`.github/workflows/release.yml:124-136`
— it installs chromium and runs `bun run test:e2e`), which is its designed tier. The PRD ruled this
before the suite existed: `tier: e2e` is *"a different approach"* from the unit/module/integration
tools that share a stack (`docs/research/PRD-crucible-v2.md:123`) and e2e is a *"broad,
orchestrator-fired sweep"* (`:396`). A **release** gate is the correct home for it, and it is
already there.

The defect is that CR-CRU-096's AC28 cited three of its lines as **in-cycle corroboration**, where
no per-cycle gate runs — nor should one. An AC citing a release-tier suite is claiming evidence its
own cycle cannot produce. CR-CRU-096 AC28a records that separately.

Downstream, the loss is total and silent: `focusedReleaseView` filters membership on
`entry?.release === version` (`public/app-logic.mjs:1263`, filter at `:1275`), so a release-less row
is a member of nothing. Zone 2 draws no wave box and zone 3 draws no rows — the CR is simply
invisible on the roadmap, with no warning anywhere, because from the store's point of view the user
never declared a release.

## Scope

### §S1 — the handler reads the fields it accepts

`handleQueuePost` populates `release`, `track` and `lifecycle` on its `QueueEntryInput` from the
posted fields, on the same footing as the fields beside them. `replaceQueue` already accepts,
normalises and stores all three, and its carry-forward already depends on them.

**Two new refusals are required, and each guards a different kind of thing.** `replaceQueue` throws
a plain `Error` when a track carries no lane number (`src/store.ts:3517-3522`), and
`handleQueuePost` catches only `QueueWaveOverflowError` (`:1884-1887`) — so wiring `track` without a
validation path would answer **500** to authored input. The handler refuses a malformed track by
name and index, as it already does for `dependsOn` and `seq`.

`lifecycle` needs the same treatment for a different reason: it is the one declared field that is a
**structure**, and `listQueue` republishes it AS a `QueueLifecycle`, so an accepted scalar or `{}`
is a value no reader of that type can trust. It is refused by name and index too — AC4b, ratified
2026-09-03. This paragraph originally said "one new refusal"; that was too narrow, and cycle 320
raised it rather than quietly widening the code.

**`queue-file` is out of scope, and is a second dropper.** `parse_queue_table` emits only
`{cr, title, wave, dependsOn}` (`clients/_crucible_axi.py:2394`) and the README table has no release
column, so the client cannot declare one either. That is a client-side gap already registered
alongside its lifecycle sibling (`docs/changes/README.md:219-225`) and belongs to a patch CR of its
own, not to a route fix.

### §S2 — an unread accepted field is a defect class, not one bug

The route's `fields` contract is the boundary where authored data enters. A field that a caller may
send, that the store's input type declares, and that the handler never reads, is indistinguishable
from success at the call site. §S2 adds a guard so the next dropped column is a test failure rather
than an invisible row.

**The guard EXTENDS `tests/helpers/source-scan.ts`, and writes no new walker.** CR-CRU-097 §S6
lifted `listFiles`, `extractCitableText`, `jsCommentRuns` and `pythonStatementStrings` into that
helper precisely so the third source-scanning test would not hand-roll a fourth tree walker —
CR-CRU-096's hand-rolled comment stripper is the defect that lesson came from. This guard consumes
those exports as-is; if it needs a capability they lack, the capability is added **there** and the
existing consumers keep passing.

**Its source of truth is the exported `QueueEntryInput` interface, because no field-level
documentation exists.** Nothing enumerates this route's entry fields — `src/hints.ts:376` names the
endpoint only. `QueueEntryInput` (`src/store.ts:270-288`) is the declared, exported, machine-readable
contract of what `replaceQueue` accepts, so the guard compares its keys against the keys the handler
reads. No new documentation format is invented.

### §S3 — declaring membership is orchestrator work, and the route must say so

**Added 2026-09-03 on the user's ruling, after §S1 landed.** The approved design states the rule
plainly: *"Who declares — **Mainline orchestrator only** — the existing `ORCHESTRATOR` role. A
track executes; it never re-plans the roadmap"* (`.lavish/crucible-workflow-flowchart.html:456`,
with the machinery table at `:404` naming `cr-plan --release` as the declaring verb).

The five roadmap routes enforce it through `requireOrchestrator` (`src/v2.ts:2181`, `:2220`,
`:2280`, `:2409`). **The bulk queue post does not** — `handleQueuePost` checks the project key and
the body shape and nothing else. Before §S1 that was harmless: the route could not write
membership, so the rule was enforced by the very defect this CR fixes. §S1 removes the accident and
leaves nothing in its place, so any caller could declare membership.

**The gate is FIELD-CONDITIONAL, not route-wide** (ruled after the alternatives were measured):

- A post declaring `release`, `track` or `lifecycle` is **roadmap registration** and requires the
  `ORCHESTRATOR` role, exactly as `cr-plan` does.
- A post declaring none of them is **queue bootstrap** and stays open. This is not a courtesy: the
  only real caller, `queue-file`, sends `{"entries": …}` with **no `agentId` at all**
  (`clients/_crucible_axi.py:2422`), so a route-wide gate would break the orchestrator's own import
  and force a client change this CR explicitly scoped out.

This is also a gap in this CR's own gap analysis, recorded rather than quietly fixed: six
dimensions were checked and none asked whether the fix respected the design's **authorization**
rule. Dimension 3 (code vs design intent) should have caught it and did not.

## Acceptance criteria

- **AC1** — `POST .../queue` with `release` declared stores it; the subsequent `GET .../queue`
  answers the row carrying that release, byte-identically to what was sent.
- **AC2** — The row is then a member of its release: `focusedReleaseView` for that version includes
  it, and zone 2 draws its wave box. Asserted through the published payload, not the DOM alone.
- **AC3** — `tests/e2e/features/roadmap-graph.feature:33-48` passes (the scenario whose post is
  line 38 and whose wave-box assertion is line 41). Since it fails at the merge-base, the fixup
  commit must show it red before and green after. Run with `bun run test:e2e` — it is not in any
  per-cycle gate, by design (see §S2's tier note and AC8).
- **AC4** — `track` and `lifecycle` are stored from the bulk post on the same footing as `release`,
  so `QueueEntryInput` has no key the route silently ignores.
- **AC4a** — A malformed `track` is refused **400** by name and index, never 500. Proven by posting
  a track with no lane number. Note the state this describes: **today the route answers 200**,
  because it never forwards `track` at all, so `replaceQueue`'s existing refusal
  (`src/store.ts:3517-3522`) is unreachable. 500 is what §S1 would create by wiring `track` without
  validation — `replaceQueue` throws a plain `Error`, not a `QueueWaveOverflowError`, and the
  handler catches only the latter. Measured 2026-09-03 (cycle 320).
- **AC4b** — A `lifecycle` that is not a `QueueLifecycle` is refused **400** by name and index.
  **Ratified by the user 2026-09-03** after cycle 320 raised it; it is a refusal this spec did not
  originally ask for, and it is now a requirement rather than an agent's addition. It asserts only
  what the type declares — `state` in `{SUPERSEDED, VOID}` and `at` a number — and asserts NOTHING
  about the disposition itself. Rationale: `replaceQueue` stringifies the value verbatim and
  `listQueue` republishes it AS a `QueueLifecycle`, so a scalar or a `{}` would be a value no
  reader of that type can trust, and accepting it silently is the exact defect class §S2 exists to
  kill. `track`'s refusal guards a normalisation; this one guards a STRUCTURE, which is why §S1's
  "exactly one new refusal" was too narrow.
- **AC5** — A guard fails when a key `QueueEntryInput` declares is never read by `handleQueuePost`.
  It must fail today if `release` is removed again, and it must consume `tests/helpers/source-scan.ts`
  rather than walk the tree itself — asserted by the helper's exports being imported, and by that
  helper's own suite staying green.
- **AC6** — Regression: posting WITHOUT `release` still stores a release-less row and still warns
  exactly as CR-CRU-095 §S2 requires. The fix must not make `release` mandatory.
- **AC7** — **The shape CR-CRU-095 §S2 declared unreachable is now specified.** That CR reasoned
  *"the bulk route never forwards `release` … a row the bulk post defaults is always new and
  release-less … bulk cross-wave `defaulted-seq` is unreachable by construction … a bulk cross-wave
  case is not specified because it cannot occur."* §S1 makes it occur: a NEW row posted with
  `release` and no `seq` is defaulted **and** release-bearing, so beside a same-release wave holding
  positional seq the release axis fires. The AC pins the answer — the row lands in its own wave
  block (CR-CRU-095 §S3), so it is in scale and warns only on a genuine difference of scale, exactly
  as `cr-plan` does. CR-CRU-095 is shipped and is not edited; this AC supersedes its reachability
  claim and cites it.
- **AC8** — The e2e suite's TIER is put on the record as a **release-tier** consumer, and the
  citation defect is recorded against the ACs that made it. The suite is NOT added to a per-cycle
  gate: it already runs in the release gate (`.github/workflows/release.yml:124-136`), which is the
  tier the PRD assigns it (`docs/research/PRD-crucible-v2.md:123`, `:396`, `:425`). A release-tier
  suite cited as per-cycle evidence is the defect; moving it would be the wrong fix.
  **REWORDED 2026-09-03, after VERIFY (cycle 322) found this AC unperformed and unperformable as
  written.** It originally read *"the ACs that cite the e2e suite … are corrected"* — those ACs are
  CR-CRU-096 AC28 (`:518-519`) and AC28a (`:521-524`), and **CR-CRU-096 is shipped**. The standing
  rule is that an implemented CR is never edited and its record is settled fact, so the original
  wording required breaking that rule to satisfy this one. It is discharged the way the rule allows:
  the tier is stated HERE (§S2's "Why nothing caught it"), this AC cites 096 AC28/AC28a by line, and
  the class is entered in the deferred register. Note what is already on record and needs no repair:
  **096 AC28a itself withdrew the corroboration claim** (*"AC28's e2e half cannot corroborate
  anything"*), so the substance was never left standing as true — what was missing, and what this AC
  adds, is naming the TIER that makes it unrunnable per-cycle by design rather than by accident.
- **AC9** — **Declaring release membership through this route requires the `ORCHESTRATOR` role, per
  §S3.** A post that declares `release`, `track` or `lifecycle` without an orchestrator caller is
  refused; a post that declares none of them is accepted exactly as today, with no `agentId`
  required. Both halves asserted: the refusal, and the unchanged open path — a guard that only
  proves the refusal would let the gate silently widen to every queue post and break `queue-file`.

## Non-goals

- **Adding playwright to a per-cycle gate.** Ruled against: e2e is a release-tier sweep by PRD
  design and already gated there.
- **`queue-file` declaring a release.** A client-side gap with its own register entry (§S1).
- **Any new source-walking helper.** §S2 extends the one CR-CRU-097 built.
