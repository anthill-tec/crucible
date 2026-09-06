# CR-CRU-108 — one published multi-track fact, and a printed-help test that cannot be starved

- **Type**: patch
- **Wave**: 5 (0.2.0)
- **Depends on**: 085, 092, 097
- **Status**: PENDING (0.2.0) — filed 2026-09-06 at the SCRUM after CR-CRU-085 merged; both halves were found by that CR's pre-merge gate and its VERIFY
- **Design reference**: `/home/antonyj/Documents/data_projects/crucible/.lavish/crucible-workflow-flowchart.html` §7 (the conditional-chrome rule) and §11 (the multi/single-track distinction is DERIVED from reported data — "nothing new has to be declared"); `docs/research/DN-model-b-language.md` (LOCKED — `track` absent = implicit solo lane)

## Context

Two defects with one shape: a fact that exists twice, and a gate that cannot be trusted to
measure it.

**The multi-track rule is computed in two places.** CR-CRU-092 §S3 defines it once —
`tracks` is the sorted set of distinct non-null `entry.track` values the queue read returned, and
the project is multi-track iff `len(tracks) > 1` — and implements it in
`clients/_crucible_axi.py` (`queue_tracks`, consumed by `resolve_next` to emit
`needs=["track"]` / `tracks[…]`). The browser then re-implements the same predicate in
`public/app-logic.mjs` (`declaredLabel` / `distinctLabels`), where CR-CRU-078 AC12 reads it for the
table's `track` column and CR-CRU-085 §S2 reads it for the wave's lanes. The two agree today by
inspection, not by construction: `queue_tracks` skips a falsy value, `declaredLabel` trims and
drops an empty string, and nothing measures them against one another. `handleQueueGet`
(`src/v2.ts`) publishes `{ok, entries}` and states no track fact at all, so the server — which owns
the normalisation (`normalizeTrack`, `TRACK_LANE_RULE`) — is the one surface that never answers the
question its own rule defines. CR-CRU-104 §S1 settled the principle for release membership: one
rule, reached by every entry point. This is the same defect on the track axis.

**The printed-help test can be starved, so the gate reports two answers for one tree.**
`tests/project-namespace-tripwire.test.ts`'s CR-CRU-097 §S2/AC2 test drives every client verb's
`--help` for real — roughly 157 `Bun.spawn` calls behind a 180 s timeout. Standalone it completes
in **2.5 s**. Run after a Chromium suite in the same bun process it hits the cap exactly:
`bun test tests/roadmap-visual-grammar.test.ts tests/project-namespace-tripwire.test.ts`
reproduces it, and reproduces identically on `1f5498c` — the commit before CR-CRU-085 branched — so
it is order-dependent and pre-existing, not that CR's. Measured consequence: three
`pre-merge-gate` runs of one tree answered 2122/1, 2122/1 and 2123/0, with every other slow test's
duration identical to the millisecond. A gate that answers differently on re-run cannot gate.

## Scope

### §S1 The queue read publishes the tracks it stores

`handleQueueGet` publishes the project's declared tracks beside its entries, by the rule
CR-CRU-092 §S3 already defines: the sorted distinct non-blank `track` values over the entries the
read returns, echoed AS STORED (a legacy un-normalised row is a fact about the roadmap, not
something a read path may rewrite). It is a DERIVED fact, so nothing new is declared and no write
path changes — design §11's constraint holds.

**Surfaces (verified 2026-09-06):** `handleQueueGet` returns `{ok: true, entries: store.listQueue(key)}`
(`src/v2.ts`); the rule lives in `queue_tracks` (`clients/_crucible_axi.py`); the store already
normalises on write (`normalizeTrack`, `replaceQueue`, `declareMembership`).

### §S2 The fleet reads the published fact instead of re-deriving it

`queue_tracks` stops computing and starts reading the published field — a clean cutover, not a
fallback: the shared client's own copy of the rule is deleted, and `resolve_next`'s
`needs=["track"]` / `tracks[…]` / `totalCount` refusal is driven by what the server published.
CR-CRU-092's `next` contract does not change on the wire; only where its answer comes from does.

### §S3 The renderer's SCOPED derivations are proven to agree with the published rule

Zone 2's two reads are deliberately scoped and stay so: the table's `track` column derives over the
focused release's membership (CR-CRU-078 AC12) and the lanes derive over ONE wave's membership
(CR-CRU-085 §S2), which is why neither can be replaced by a project-level list. What changes is
that their PREDICATE — which value counts as a declared track — is pinned against the published
one, over a fixture carrying the cases that could diverge: a blank string, a whitespace-only
string, `null`, and a legacy un-normalised value such as `"2"` beside a normalised `"track-2"`.

### §S4 The printed-help test cannot be starved

The CR-CRU-097 §S2/AC2 test answers the same way whichever suites precede it. The remedy may not
weaken what it asserts: every client verb's printed help, driven for real, is still inspected for a
CR-namespace literal, and the non-vacuity floors (≥150 surfaces, ≥25 verbs per client, every root
help present, no non-zero exit) stay. Its 180 s cap is a symptom, not the contract — raising the
cap alone is not a fix, because it leaves the gate's answer dependent on file order.

## Acceptance criteria

- **AC1** — `GET /api/v2/projects/<key>/queue` publishes `tracks`: a JSON array of the sorted
  distinct `track` values over the returned entries, excluding `null`, absent and blank/whitespace-only
  values, each echoed exactly as stored. A queue whose entries declare no track publishes `tracks: []`
  — an empty array, never an absent key, so "no tracks" is a stated fact.
- **AC2** — the published list is not re-spelled: a queue holding a legacy `"2"` and a normalised
  `"track-2"` publishes BOTH values, sorted, and the read path rewrites neither.
- **AC3** — the TOON envelope carries the same field under the same name, and `?fields=` narrowing
  cannot silently drop it when the caller asked for it.
- **AC4** — `queue_tracks` in `clients/_crucible_axi.py` contains no distinct-set computation: it
  reads the published `tracks`. A grep for the old set-comprehension over `e.get("track")` returns
  zero hits outside a test.
- **AC5** — `next`'s multi-track behaviour is unchanged on the wire, driven end-to-end: a
  two-track fixture with `--track` omitted still exits 2 with `ok=false`, `needs=["track"]`,
  `tracks` equal to the published list and `totalCount` matching its length; a single-track and a
  trackless fixture still take no argument, emit no `needs` and carry no `tracks` key.
- **AC6** — one cross-surface test measures the server's published rule and the browser's
  `declaredLabel`/`distinctLabels` predicate against ONE fixture containing `null`, an absent key,
  `""`, `"   "`, `"2"` and `"track-2"`, and asserts they classify every case identically.
- **AC7** — the table's `track` column and the wave's lanes keep their scopes: a multi-wave release
  whose declared tracks all sit in one wave still shows the column and still draws lanes in that
  wave only. (CR-CRU-085 shipped this behaviour; this AC pins it against the §S2 cutover.)
- **AC8** — the CR-CRU-097 §S2/AC2 printed-help test passes when the Chromium geometry suite runs
  immediately before it in the same invocation:
  `bun test tests/roadmap-visual-grammar.test.ts tests/project-namespace-tripwire.test.ts` is green,
  and so is the reverse order.
- **AC9** — that test still asserts what it asserted: every client verb's printed `--help` plus
  every client's root help is inspected for a CR-namespace literal, with the ≥150-surface,
  ≥25-verbs-per-client, root-help-present and zero-non-zero-exit floors intact. A test asserting
  fewer surfaces than before does not satisfy this CR.
- **AC10** — three consecutive `pre-merge-gate` runs on the same tree report the SAME pass/fail
  counts. Recorded in the close-out as three figures, not one.
- **AC11** — integration, not stub: after this CR, `handleQueueGet` is the only producer of the
  track list, and a grep shows ≥1 non-test caller reading it in `clients/_crucible_axi.py`. Zero
  non-test callers means the field is unwired and the CR is incomplete.

## Estimated size

S–M — one published field, one client cutover, one cross-surface predicate test, and one test
isolated from its neighbours.

## Risk

The `next` contract is the fleet's scheduling oracle, and §S2 moves where its answer comes from. A
queue read that fails or omits `tracks` must not silently make a multi-track project look
single-track: that would let `next` pick a lane it is forbidden to pick (design §11 — "never picks
a lane for you"). The cutover therefore has to fail loudly rather than degrade to a derived guess,
and AC5 exists to prove the observable behaviour did not move.

Second risk: whatever isolates the printed-help test must not become a second way to run tests that
the gate does not exercise. If the remedy is a separate invocation, `pre-merge-gate` runs it — a
test the gate no longer runs is worse than a test that sometimes times out.

## Non-goals

- Changing what a track IS, how it is declared, or `normalizeTrack`'s wire format.
- Publishing a project-level "is multi-track" boolean: the list is the fact, and `len(tracks) > 1`
  is the reading — a second field would be a second rule.
- Replacing zone 2's scoped derivations with the project-level list (§S3 — the scopes are
  deliberate).
- The lane rendering itself — CR-CRU-085, shipped.
- Fixing the Chromium suite's own resource handling beyond what AC8 requires.
