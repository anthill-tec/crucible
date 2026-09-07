# CR-CRU-108 — one published multi-track fact

- **Type**: patch
- **Wave**: 5 (0.2.0)
- **Depends on**: 085, 092, 097
- **Status**: PENDING (0.2.0) — filed 2026-09-06 at the SCRUM after CR-CRU-085 merged. The printed-help half was split out to CR-CRU-110 on 2026-09-07: its stated cause was disproved by measurement, so it needs a diagnosis this CR should not wait on.
- **Design reference**: `/home/antonyj/Documents/data_projects/crucible/.lavish/crucible-workflow-flowchart.html` §7 (the conditional-chrome rule) and §11 (the multi/single-track distinction is DERIVED from reported data — "nothing new has to be declared"); `docs/research/DN-model-b-language.md` (LOCKED — `track` absent = implicit solo lane)

## Context

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

**Measured 2026-09-07: the two rules do not merely agree by inspection — they DISAGREE.** Driven
over the fixture AC6 names (`null`, an absent key, `""`, `"   "`, `"2"`, `"track-2"`,
`" track-2 "`):

| rule | result |
|---|---|
| `queue_tracks` (`clients/_crucible_axi.py`) | `['   ', ' track-2 ', '2', 'track-2']` — **4** |
| `declaredLabel`/`distinctLabels` (`public/app-logic.mjs`) | `['2', 'track-2']` — **2** |

The client rule filters on truthiness and never trims, so a whitespace-only value IS a track to it
and a padded value is a different string; the browser trims and drops blanks. A queue declaring
`"   "` and `"2"` is therefore multi-track to `next` and single-track to the renderer today. That
is the divergence §S1 removes, and AC5 pins the behaviour change it implies.

## Scope

### §S1 The queue read publishes the tracks it stores

`handleQueueGet` publishes the project's declared tracks beside its entries, by the rule
CR-CRU-092 §S3 already defines: the sorted distinct non-blank `track` values over the entries the
read returns, echoed AS STORED (a legacy un-normalised row is a fact about the roadmap, not
something a read path may rewrite). It is a DERIVED fact, so nothing new is declared and no write
path changes — design §11's constraint holds.

**AS STORED means never RE-SPELLED, not whitespace-preserved.** A stored `"2"` publishes as `"2"`,
never as `"track-2"`. But identity is the TRIMMED value, and the trimmed value is what is
published: `normalizeTrack` (`src/store.ts`) returns `track-<n>` and exists, by its own docstring,
so that "two clients writing `2` and `track-2`" cannot "produce two lanes for one track" — so a
padded value is malformed data no write path can produce, not a roadmap fact worth preserving.
Preserving the padding would recreate exactly the double-lane defect that function prevents.

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
one, over a fixture carrying the cases MEASURED to diverge today: `null`, an absent key, `""`, a
whitespace-only `"   "`, a padded `" track-2 "` beside `"track-2"`, and a legacy un-normalised
`"2"` beside `"track-2"`.

## Acceptance criteria

- **AC1** — `GET /api/v2/projects/<key>/queue` publishes `tracks`: a JSON array of the sorted
  distinct `track` values over the returned entries, excluding `null`, absent and blank/whitespace-only
  values, each echoed exactly as stored. A queue whose entries declare no track publishes `tracks: []`
  — an empty array, never an absent key, so "no tracks" is a stated fact.
- **AC2** — the published list is not re-spelled: a queue holding a legacy `"2"` and a normalised
  `"track-2"` publishes BOTH values, sorted, and the read path rewrites neither. Trimming is not
  re-spelling: a stored `" track-2 "` publishes as `"track-2"` and collapses with it into ONE
  track, and a test asserts both halves of that sentence.
- **AC3** — the TOON envelope carries the same field under the same name, asserted by reading the
  `?fmt=toon` reply, not by trusting `reply()`. There is no `?fields=` on the wire — narrowing is
  CLIENT-side (`select_row_fields`, `next_projection`), so the assertion that matters is that
  `next`'s `--fields` projection can still SELECT `tracks`, and that a projection which omits it
  narrows the printed envelope without changing the decision.
- **AC4** — `queue_tracks` in `clients/_crucible_axi.py` contains no distinct-set computation: it
  reads the published `tracks`. A grep for the old set-comprehension over `e.get("track")` returns
  zero hits outside a test. `queue_tracks` is the shared delegator all five `*-crucible.py` clients
  reach, so one cutover covers the fleet — the grep is repo-wide, over `clients/`, not one file.
- **AC5** — `next`'s multi-track behaviour is unchanged on the wire for every value that classifies
  the same under both rules, driven end-to-end **per client** (all five `*-crucible.py`): a
  two-track fixture with `--track` omitted still exits 2 with `ok=false`, `needs=["track"]`,
  `tracks` equal to the published list and `totalCount` matching its length; a single-track and a
  trackless fixture still take no argument, emit no `needs` and carry no `tracks` key.
- **AC5b** — the ONE behaviour change this CR makes is pinned as a change, not left silent: a queue
  declaring `"   "` beside `"2"` is multi-track to `next` today (it refuses without `--track`) and
  becomes single-track after, because the server's rule is the one that survives. A test drives
  `next` over that fixture and asserts the NEW answer, citing this AC as the reason the old one
  was wrong. The padded-value case (`" track-2 "` beside `"track-2"`) is asserted the same way:
  one track, not two.
- **AC6** — one cross-surface test measures the server's published rule and the browser's
  `declaredLabel`/`distinctLabels` predicate against ONE fixture containing `null`, an absent key,
  `""`, `"   "`, `" track-2 "`, `"2"` and `"track-2"`, and asserts they classify every case
  identically. Measured 2026-09-07, that fixture is where they DISAGREE today — the client rule
  answers four tracks and the browser two — so the test fails before the §S1/§S2 cutover lands.
- **AC7** — the table's `track` column and the wave's lanes keep their scopes: a multi-wave release
  whose declared tracks all sit in one wave still shows the column and still draws lanes in that
  wave only. (CR-CRU-085 shipped this behaviour; this AC pins it against the §S2 cutover.)
- **AC8** — integration, not stub: after this CR, `handleQueueGet` is the only producer of the
  track list, and a grep shows ≥1 non-test caller reading it in `clients/_crucible_axi.py`. Zero
  non-test callers means the field is unwired and the CR is incomplete.

## Estimated size

S–M — one published field, one client cutover, one cross-surface predicate test, and one pinned
behaviour change.

## Risk

The `next` contract is the fleet's scheduling oracle, and §S2 moves where its answer comes from. A
queue read that fails or omits `tracks` must not silently make a multi-track project look
single-track: that would let `next` pick a lane it is forbidden to pick (design §11 — "never picks
a lane for you"). The cutover therefore has to fail loudly rather than degrade to a derived guess,
and AC5 exists to prove the observable behaviour did not move where it must not.

Second risk: the whitespace collapse (AC5b) IS an observable change to the oracle's answer, so it
must land as a stated one. A queue whose only second "track" is `"   "` refuses `next` today and
stops refusing after — correct, but invisible unless asserted, which is why AC5b drives `next`
over that fixture rather than reasoning about it.

Blast radius, measured 2026-09-07: `PROSE_CITATIONS.clients` is at **691** and `src` at **560**,
and §S1/§S2 touch `src/v2.ts` and `clients/_crucible_axi.py`, so both heads move — ONE re-record at
close-out, not a mid-cycle escalation. `test_cr092_next_decision_resolver`'s guarded citations pin
`canonical_track`/`LANDED_STATUSES` into `src/store.ts` and `_next_start_help` into
`python-crucible.py`; neither file is edited here, so those pins should hold — verify, don't assume.

## Non-goals

- Changing what a track IS, how it is declared, or `normalizeTrack`'s wire format.
- Publishing a project-level "is multi-track" boolean: the list is the fact, and `len(tracks) > 1`
  is the reading — a second field would be a second rule.
- Replacing zone 2's scoped derivations with the project-level list (§S3 — the scopes are
  deliberate).
- The lane rendering itself — CR-CRU-085, shipped.
- The printed-help test's order-dependence — split out to CR-CRU-110 on 2026-09-07, because its
  filed cause (subprocess starvation) was disproved by measurement and needs a diagnosis first.
