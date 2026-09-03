# CR-CRU-099 — a declared release is dropped on queue post

- **Type**: bug
- **Wave**: 5 (0.2.0) — release membership is the user's call
- **Depends on**: none — the fix is local to one request handler
- **Status**: PENDING (0.2.0) — filed 2026-09-02, **gap-analysed and corrected 2026-09-03**
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
- **AC8** — The ACs that cite the e2e suite as in-cycle corroboration are corrected to name it as a
  **release-tier** consumer. The suite is NOT added to a per-cycle gate: it already runs in the
  release gate (`.github/workflows/release.yml:124-136`), which is the tier the PRD assigns it
  (`docs/research/PRD-crucible-v2.md:123`, `:396`, `:425`). A release-tier suite cited as per-cycle
  evidence is the defect; moving it would be the wrong fix.

## Non-goals

- **Adding playwright to a per-cycle gate.** Ruled against: e2e is a release-tier sweep by PRD
  design and already gated there.
- **`queue-file` declaring a release.** A client-side gap with its own register entry (§S1).
- **Any new source-walking helper.** §S2 extends the one CR-CRU-097 built.
