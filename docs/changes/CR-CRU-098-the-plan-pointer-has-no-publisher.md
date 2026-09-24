# CR-CRU-098 — the plan pointer has no publisher

- **Type**: feature
- **Wave**: 7 (0.3.0) · **Points**: 13 (re-sized from 5 at gap analysis, 2026-09-24, user ruling)
- **Depends on**: 095 — the pointer walks `listQueue`'s published order, which 095 made the
  server's one canonical answer.
- **Status**: PENDING — filed 2026-09-02, re-specified at gap analysis 2026-09-24
- **Found by**: CR-096's gap analysis (DRIFT-1) — its AC12 wanted to render which CR to take up
  next, and there is no way to READ that.

## Problem

The scheduling decision is **authored**: Mainline, with the user, sets the roadmap — wave,
release, `seq`, dependencies — and Crucible records it. `next` is the **pointer** into that
authored plan: it tells the executing orchestrator which CR to take up next. Crucible is the
reference to the plan.

The pointer is computed inside the shared client module, `clients/_crucible_axi.py:2276-2990`
(715 lines, measured 2026-09-24 at `7f2a85c`). The server publishes no pointer: there is no `next`
route, and the resolver's vocabulary (`NEXT`/`HOLD`/`DRAINED`) occurs nowhere in `src/`.

So the plan's own reference cannot hand out the pointer it holds. Any consumer that is not this
Python module must recompute it — a second implementation of a pointer into data the server
already owns, which is what CR-091 AC18 ruled out for `seq` and CR-095 §S1 deleted from the client
for ordering.

**Measured at gap analysis:** no second consumer exists in this repo today — all five clients call
the one shared resolver, and the board's `nextCr` marker is deliberately positional
(`public/app-logic.mjs:1544-1564`). The user ruled to proceed regardless (2026-09-24): the pointer
belongs with the data it points into.

## Scope

### §S1 — the server resolves the pointer

The resolver moves to the server, over `listQueue`'s published order and the project's declared
tracks — the inputs it takes today. It is a **pure function** over those inputs (entries, tracks,
and the `track`/`release`/`wave` scope), so its behaviours are testable without HTTP.

Semantics are preserved exactly, including every behaviour CR-092, CR-095 and CR-108 gave it:
`NEXT`/`HOLD`/`DRAINED`, the four trigger kinds in their fixed precedence (`in-flight`,
`dead-dependency`, `dependency`, `unknown-dependency`), the three drain reasons, the dead-CR skip
(`lifecycle` present ⇒ not actionable; shipped since 0.2.0), the `waveCompleted` boundary
announcement, and the `missing-seq` / `unknown-dependency` warnings.

Derived and read-only: no column, no cached answer. A stored pointer goes stale the moment a row
changes, and the board would then hold two.

### §S2 — a route publishes the WHOLE answer, `help[]` included

`GET /api/v2/projects/<key>/next`, with optional `track`, `release` and `wave` query parameters.

The response is the complete answer: every field the client emits today, **plus `warnings[]` and
`help[]`, authored by the server** (user ruling 2026-09-24). v2 responses already carry
server-authored `help` (`src/v2.ts:886`) and v2 refusals already name client verbs. DRAINED's help
needs facts that are not answer fields (the lane's dead CRs, the next wave's label); authoring it
server-side keeps the whole pointer in one place.

The multi-track refusal is `fail(400, …)` carrying `needs: ["track"]`, `tracks`, `totalCount` and
`help` — the same fields the client refusal carries today. The project key is validated like
every other v2 route.

### §S3 — the client becomes a consumer

The client's `next` verb makes one `GET …/next`, passes its flags through, and emits what it
receives. It keeps only the verb itself, the human line (`_next_legacy_line`), the context
override (`next_context`) and the `--fields` projection (`next_projection`) — presentation of an
answer, not derivation of one. Output — human line, AXI envelope, exit code — is byte-identical.

### §S4 — the boundary this CR removes takes its tests with it

Three things in the resolver exist only because the pointer lived on the far side of a wire from
the data:

- **the track fact could be unpublished** — CR-108's `QueueTrackFactUnpublished` / `queue_tracks`
  refusal. On the server the resolver reads the declared tracks directly; the case cannot arise.
- **the client mirrors the server's track rule** — `canonical_track` vs `normalizeTrack`. ~~With one
  side, there is no mirror.~~ **Corrected at C3 (2026-09-24):** the mirror survives. `next_context`
  stamps `context.track` from the canonicalised `--track` flag, and in a single-track project the
  answer carries no `track` (AC4's `_lane_fields` rule), so the client cannot take it from the
  answer without changing the envelope (AC9). `canonical_track` therefore stays, and
  `TrackCanonicalisationAgreesWithTheServerTest` stays with it; it is not retired.
- **line citations into the client block** — `NextBlockCitationsTest`.

These are retired, not ported, and each retirement is recorded where the test stood.

## Acceptance criteria

**§S1**
- **AC1** — A pure server function resolves the pointer from `(entries, tracks, {track, release,
  wave})`. Every `QueueEntry` it reads comes from `listQueue`; no other ordering rule exists in it
  (no sort, no `seq` comparison).
- **AC2** — Every behaviour of every test that reaches an AC10 symbol — `tests/client/test_cr092_next_decision_resolver.py` (85 tests,
  measured at `7f2a85c`), `tests/client/test_cr095_next_consumes_published_order.py`, and any other
  test file RED's census finds (C1 found `test_next_announces_the_wave_boundary.py` and
  `test_next_lane_carries_release_and_wave.py`, missed by the gap analysis) — is
  classified in the RED commit into exactly one of: **ported** to a bun test of the server function
  or route, **kept** as a Python verb test (envelope, exit code, projection, context, transport
  failure), or **retired** under §S4. The classification table is in the RED commit message or a
  file it names. Ported tests are not weakened; the retired set is exactly §S4's.
- **AC3** — Nothing is stored: no schema change (`SCHEMA_VERSION` unchanged), no cached answer. Two
  reads of an unchanged board agree; a read after a queue write reflects it.

**§S2**
- **AC4** — `GET …/next` returns, per decision, exactly the fields the client emits today:
  `decision`; `cr` and `seq` (NEXT, HOLD); `trigger` (HOLD); `reason` (DRAINED); `release`, `wave`,
  `track` per the existing `_lane_fields` rules (absent, never null or defaulted);
  `waveCompleted` when a crossing is proven; `warnings[]`; `help[]`.
- **AC5** — `help[]` is authored by the server, and for every decision and every trigger kind and
  drain reason it is **string-identical** to what `_next_start_help`, `_hold_help` and
  `_drained_help` produce today for the same board, the DRAINED corpse list and next-wave label
  included.
- **AC6** — The `track`, `release` and `wave` parameters scope exactly as the client flags do
  today: verbatim matching for release and wave, the canonical track rule for track, and
  CR-CRU-092's multi-track refusal as `400` with `needs`, `tracks`, `totalCount`, `help`.
- **AC7** — An unknown or malformed project key is refused like every other v2 route.

**§S3**
- **AC8** — `python-crucible.py next` makes exactly one request, a `GET` of `…/next`, with its flags
  passed as query parameters; it no longer reads `…/queue`.
- **AC9** — The human line, AXI envelope and exit code are byte-identical to today's for the same
  board, across NEXT, each HOLD kind, each DRAINED reason, the multi-track refusal (exit 2), and a
  failed read (exit 1, no `decision` key). Every decision still exits 0.
- **AC10** — None of these has a definition left in `clients/_crucible_axi.py`:
  `LANDED_STATUSES` (unless another verb uses it), `QueueTrackFactUnpublished`, `queue_tracks`,
  `_entry_seq`, `_is_actionable`, `_dead_entries`, `_dead_phrase`, `_next_start_help`,
  `_hold_help`, `_drained_help`, `_next_trigger`, `_lane_fields`, `_announced_fields`,
  `_next_answer`, `_drained_answer`, `_wave_of_the_lane`, `_previous_published_wave`,
  `_next_published_wave`, `_boundary_announcement`, `resolve_next`. `canonical_track` **stays**: it is
  the `next_context` stamp's canonicaliser, and the answer cannot supply it in a single-track project
  (§S4, corrected at C3).
- **AC11** — All five clients reach `next` through the one shared `cmd_next`; none defines its own.

**§S4**
- **AC12** — `PublishedTrackFactTest`, `PublishedTrackFactIsWiredTest`, `NextBlockCitationsTest` and
  the census's `Cr108PublishedTrackFactTest` (`test_client_fleet_envelope_census.py`) are removed,
  each with a comment where it stood naming this CR and the reason in §S4. Behaviours of theirs that
  now live server-side (blank/padded declared tracks) are ported to the route tests, not dropped.
  `TrackCanonicalisationAgreesWithTheServerTest` is **not** retired (§S4, corrected at C3).

**All**
- **AC13** — All fixtures are synthetic (CR-096 AC29).
- **AC14** — Citation pins into `clients/_crucible_axi.py` that the deletion shifts, and the
  tripwire's `PROSE_CITATIONS`, are re-pinned once, at close-out.

## Non-goals

- **Changing what the pointer says.** Semantics are `resolve_next`'s current ones, exactly — the
  dead-dependency HOLD included. If CR-CRU-147 changes what a dead dependency means, it changes the
  server function this CR creates.
- **Renaming the published `decision` field.** It names the authored decision the pointer reads
  out, and it is accurate. An earlier draft of this CR proposed renaming it; the user corrected
  that on 2026-09-02 and the proposal is withdrawn.
- **Rendering it.** The board's `nextCr` stays positional; no HOLD/DRAINED is drawn.
- **Fleet parity work.** Clients inherit the published pointer; anything beyond that belongs to
  CR-CRU-075.

## Notes

**Two mis-framings by me, both corrected by the user.** Filed first as "the scheduling decision has
no publisher" — treating the pointer as the decision. Then rewritten to call it a "reading" and to
rename the `decision` field — over-correcting into the opposite error, and bundling a fleet-wide
envelope rename, a vocabulary argument and the publisher into one CR. The decision is authored data
in the roadmap; `next` points at it; the only defect is that the pointer has no publisher. One
concern.

**Gap analysis 2026-09-24** (baseline bun 2663/0, python 2030/0 at `7f2a85c`). Findings folded in:
the spec named 3 of the block's symbols (now AC10 names all); "77 behaviours" was 85 tests, of
which four classes test the boundary this CR removes (§S4); the answer's scoping, `help[]`,
warnings and refusal shape were unspecified (§S2); the header named wave 6. The user re-sized the
CR to 13 points and ruled that the server authors `help[]`.

## Coupling (recorded 2026-09-24, corrected at gap analysis)

The planning-game note said "if CR-CRU-147 lands first, this CR ports its dead-CR skip". **The
skip already exists**: `_is_actionable`, `_dead_entries` and the `dead-dependency` trigger have
been in the resolver since `da67a55` (CR-092, 2026-08-28) and shipped in 0.2.0–0.2.2. Measured live:
`next --wave 5` names CR-CRU-082 (VOID) as a corpse and does not offer it. This CR ports that
behaviour like any other. CR-147 lands after this one and, if it changes `next` at all, changes the
server function. Never two resolvers.
