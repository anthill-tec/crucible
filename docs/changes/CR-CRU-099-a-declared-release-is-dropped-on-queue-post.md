# CR-CRU-099 — a declared release is dropped on queue post

- **Type**: bug
- **Wave**: 5 (0.2.0) — release membership is the user's call
- **Depends on**: none — the fix is local to one request handler
- **Status**: PENDING (0.2.0) — filed 2026-09-02
- **Found by**: CR-CRU-096's VERIFY cycle, running an e2e scenario no cycle had run

## Problem

`POST /api/v2/projects/<key>/queue` accepts a `release` field, answers `200`, and **silently
discards it**. `handleQueuePost` (`src/v2.ts:1846-1878`) never reads `fields.release` when building
its `QueueEntryInput`, so the row is stored with no release and the subsequent
`GET .../queue` answers it release-less.

`git log -S"fields.release" -- src/v2.ts` is **empty**. It has never been read — not since
CR-CRU-078 rewrote the roadmap e2e scenario to declare one.

This is not a rendering defect. The write path loses authored data.

## Why nothing caught it

The one consumer that would have noticed is `tests/e2e/features/roadmap-graph.feature:41-46`, which
posts a CR declaring release `0.2.0` and then expects zone 2 to draw its wave box. It fails at
`tests/e2e/steps/roadmap-graph.steps.ts:83` — and fails **identically at CR-CRU-096's merge-base**,
so it is a standing failure, not a regression.

It went unnoticed because it is a **playwright** feature, while every gate this project runs is
`bun` and `pytest`. The e2e suite is named by ACs as a consumer (CR-CRU-096 AC28 names three of its
lines) but is not in any regression gate, so an AC could cite it as corroboration while it could not
corroborate anything. CR-CRU-096 AC28a records that separately.

Downstream, the loss is total and silent: `focusedReleaseView` filters membership on
`entry.release === version` (`public/app-logic.mjs:1128-1131`), so a release-less row is a member of
nothing. Zone 2 draws no wave box and zone 3 draws no rows — the CR is simply invisible on the
roadmap, with no warning anywhere, because from the store's point of view the user never declared a
release.

## Scope

### §S1 — the handler reads the field it accepts

`handleQueuePost` populates `release` on its `QueueEntryInput` from `fields.release`, on the same
footing as the fields beside it. No new validation is introduced: `replaceQueue` and
`upsertQueueEntry` already accept and store the column, and `queue-file` already writes it — this
route is the only writer that drops it.

### §S2 — an unread accepted field is a defect class, not one bug

The route's `fields` contract is the boundary where authored data enters. A field that a caller may
send, that the route names in its help, and that the handler never reads, is indistinguishable from
success at the call site. §S2 adds a guard that fails when a route accepts a field name it never
consumes, so the next dropped column is a test failure rather than an invisible row.

## Acceptance criteria

- **AC1** — `POST .../queue` with `release` declared stores it; the subsequent `GET .../queue`
  answers the row carrying that release, byte-identically to what was sent.
- **AC2** — The row is then a member of its release: `focusedReleaseView` for that version includes
  it, and zone 2 draws its wave box. Asserted through the published payload, not the DOM alone.
- **AC3** — `tests/e2e/features/roadmap-graph.feature:41-46` passes. Since it fails at the
  merge-base, the fixup commit must show it red before and green after.
- **AC4** — A route-level guard fails when a documented `fields` key is never read by its handler.
  The guard must fail today if `fields.release` is removed again.
- **AC5** — Regression: posting WITHOUT `release` still stores a release-less row and still warns
  exactly as CR-CRU-095 §S2 requires. The fix must not make `release` mandatory.
- **AC6** — The e2e suite is named in a gate, or the ACs that cite it are corrected to stop claiming
  corroboration it cannot give. A cited consumer that no gate runs is not evidence.
