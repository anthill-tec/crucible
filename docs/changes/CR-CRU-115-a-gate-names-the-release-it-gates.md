# CR-CRU-115 — a gate names the release it gates, and never seals a run that is still going

- **Type**: bugfix
- **Wave**: 6 (0.2.0)
- **Depends on**: 013, 073
- **Status**: PENDING (0.2.0)
- **Design reference**: `docs/research/DN-crucible-wave-track-release.md` — the drift section's **D3**
  (the release's in-flight state already has a carrier: the gate), and "What a release IS" §2, which
  makes the no-mistakes run the release workflow's tracked trace

## Context

Three faults in one contract, all measured during the 0.2.0 release on 2026-09-09. `gate-run` seals a
gate from a snapshot without first establishing that the snapshot is **terminal** and that the gate is
**release-identified**.

1. **Interim gates can never be posted.** The streaming POST is guarded by
   `if in_flight and 0 < nsteps < 9`, where `nsteps = len(steps)` from `gate_from_axi`. The intent was
   "a partial ladder, not a full snapshot masquerading as interim" — but `no-mistakes axi status`
   always emits **nine** rows, with unrun steps carrying `status: pending`. Run against a live
   in-flight run: `nsteps=9`, guard `False`. The board received nothing for a 45-minute pipeline.
2. **A bounded hold is sealed as `passed`.** `axi run` returns after 8 minutes with
   `error: wait of 8m0s elapsed while driving the run` and help stating "this bounded hold ended; it is
   not a pipeline failure". `gate_from_axi(final=True)` finds no `outcome` key, and the fallback
   `("failed" if any_failed else "passed")` yields **`passed`** — `pending` and `awaiting_approval` are
   not `failed`, so the fallback is structurally biased toward green. The gate was posted with
   `ok=True outcome=passed` while the run sat at `review, awaiting_approval, 4 findings`. The
   snapshot's own `error` key is ignored, so the terminus question is answerable from data already in
   hand.
3. **No gate carries `version`.** `recordGateEvent` stores `version` first-class and retires a gate
   whose `version` equals a recorded release's `label` — "never parsed back out of the free-text
   intent" — but `post_gate` posts `{projectKey, agentId, gate}` plus optional `context` in all five
   clients, and `gate-report` has no release flag. Verified on the live event
   `evt-1788925414091-197`: `version` absent, `retiredAt` none. CR-CRU-073's retirement mechanism is
   unreachable through the client fleet, and the false gate from fault 2 can never be retired.

**Surfaces (verified 2026-09-09):** `cmd_gate_run`, `cmd_gate_report`, `post_gate`, `gate_from_axi`,
`map_axi_step_status`, `_decode_axi_snapshot`, `_GATE_POLL_CADENCE_S` in `clients/_crucible_axi.py`;
`_post_gate` and the `gate-run`/`gate-report` wrappers in each of the five clients;
`recordGateEvent(projectKey, agentId, gate, meta?: {context, role, version})` and the release
transaction that stamps `retired_at` in `src/store.ts`; `POST /api/v2/gates` in `src/v2.ts`.

## Scope

### §S1 A gate states which release it gates

`gate-run` and `gate-report` accept `--release <label>` and post it as the event's `version`. The
field is the server's existing first-class one; nothing is parsed out of the intent text.

The flag is **optional**, because a gate on a feature branch gates no release: omitted ⇒ no `version`
is sent and today's payload shape is unchanged. Supplied ⇒ the label travels verbatim, and the client
never invents, normalises or derives it from a branch name.

This is what makes "a release is in flight" readable without a new record kind: a gate carrying
`version: X` with no release recorded for `X` is a release under way, and once `X` ships the server's
existing transaction retires it.

**Only a SEAL carries the release — ruled 2026-09-10 at cycle 403**, from RED's scope question. The
interim POST inside `cmd_gate_run`'s poll loop is left unstamped. Two reasons, both structural: a
version-stamped gate is retention-protected (`LIVE_GATE`, `src/store.ts`), so stamping every interim
snapshot would leave a run's worth of unprunable gates behind for one release; and an in-flight gate
restates its release at the seal anyway, so the stamp would carry no fact the seal does not. Today
the interim POST is unreachable regardless (the guard CR-CRU-117 owns), so this ruling is asserted
there, as one of that CR's criteria, rather than by a fixture here that cannot be built.

### §S2 — MOVED OUT OF THIS CR to CR-CRU-117 (gap analysis, 2026-09-10)

Fault 1 is real and its diagnosis stands: the guard is `if in_flight and 0 < nsteps < 9` while the
real tool always emits nine rows, so no interim gate can ever be posted. **But turning the stream on
cannot be done client-only, and doing it as specified would corrupt the roadmap.**

Measured on this tree: `gate_from_axi(..., final=False)` synthesises `checks-passed`, and
`workflowLens` in `public/app-logic.mjs` flips a wave to `gated` for `passed` OR `checks-passed`,
from a Set that nothing ever removes from. So a two-second-old in-flight snapshot would mark its
wave **permanently gated** — and a run that subsequently FAILED could not un-gate it, because a
`failed` gate is not subtractive. The legal outcome vocabulary is `checks-passed, passed, failed,
cancelled`: there is no non-gating "in progress" value, so the interim-vs-seal distinction has to be
made somewhere the reader can see it. That is a design decision touching `public/` (and possibly
`src/`), which is why it is now CR-CRU-117 rather than a clause here.

This CR therefore keeps its "no server, no renderer change" property, and §S3 no longer leans on
interim posting to make a hold visible.

### §S3 A run that is still going is never sealed

A return whose snapshot carries no resolved `outcome` is a **hold**, not a terminus. `gate-run` then:
posts no gate claiming an outcome; reports the hold, naming the snapshot's own `error` when it carries
one; and states the reattach move.

**Amended 2026-09-10 (gap analysis).** The original clause said the ladder "still reaches the board as
an interim gate, so the hold is visible without being a verdict" — that depended on §S2, which is now
CR-CRU-117, and on the very outcome (`checks-passed`) the renderer reads as a seal. A hold is
reported to its CALLER and posts nothing until CR-CRU-117 gives an in-flight gate a shape the reader
cannot mistake for a verdict. Silence on the board is the honest state today; a false green is not.

The green fallback is removed from the sealing path. A final gate's `outcome` comes from the run's own
resolved `outcome`; a failed step still seals `failed`; nothing infers `passed` from the absence of a
failure.

### §S4 The envelope says what was posted

`gate-run`'s envelope states the release it stamped (or that it stamped none), whether the gate it
posted was interim or final, and — when it did not seal — that the run is still in flight.

## Acceptance criteria

**§S1 — release identity**

- [ ] `gate-run --help` and `gate-report --help` both list `--release`; all five clients expose it,
      asserted per client, with the client count itself asserted (5).
- [ ] With `--release 0.2.0`, the POST body to `/api/v2/gates` contains `"version": "0.2.0"` verbatim
      at the top level (a sibling of `gate`, never inside it).
- [ ] With no `--release`, the POST body contains **no** `version` key at all — asserted by key
      absence, not by an empty value.
- [ ] A label the client cannot recognise is still sent verbatim: `--release 9.9.9-rc.1` posts
      `"version": "9.9.9-rc.1"`.
- [ ] End-to-end against a real store: a gate posted with `--release <label>` where a release with that
      `label` is already recorded comes back with `retiredAt` set (CR-CRU-073's insert-time retirement,
      reached through the client for the first time).

**§S2 — MOVED to CR-CRU-117.** These four criteria left with it, unchanged in substance. Nothing in
this CR alters the interim guard, so the guard's own tests stay exactly as they are.

**§S3 — no false seal**

- [ ] Given the bounded-hold return — `error: wait of 8m0s elapsed while driving the run`, no
      `outcome`, `review` at `awaiting_approval` — `cmd_gate_run` posts **no** gate whose `outcome` is
      `passed`, exits non-zero, and its stderr/envelope names the hold and the reattach move.
- [ ] `gate_from_axi(..., final=True)` on a snapshot with no `outcome` does not return `passed`:
      asserted for `pending`, `running`, `fixing` and `awaiting_approval` step states, all four.
- [ ] A snapshot with a resolved `outcome: passed` still seals `passed`, and one with a `failed` step
      still seals `failed` — the fix narrows the fallback without changing a real verdict.
- [ ] `passed-with-skips` — the outcome this release actually produced — maps to `passed`
      **EXPLICITLY, by a named pass-family table**, never by the absence-of-failure fallback, and the
      envelope reports the RAW outcome verbatim beside it.

  **Rescoped 2026-09-10 (gap analysis).** "Seals verbatim" is unbuildable inside this CR: measured
  today, `no-mistakes axi status` on this project's own release run resolves
  `outcome: passed-with-skips`, and that string is in NEITHER vocabulary — not the server's
  `GATE_OUTCOMES` (`src/v2.ts`, which 400s anything outside `checks-passed, passed, failed,
  cancelled`), not the client tuple, and not the renderer's gating rule. Sending it verbatim would
  need all three trees to change and would contradict this CR's own empty-`src`/`public` criterion.
  The skip information is NOT lost by the mapping: `steps[]` already carries `pr,skipped` and
  `ci,skipped` on the wire. Extending the vocabulary properly is a candidate CR, recorded in the
  queue notes.
- [ ] An outcome that is resolved but belongs to NO pass family is never sealed as `passed`: it is
      reported verbatim and the run is treated as unsealed. This is the fallback's real defect — a
      value the fleet does not understand must not become green.

**§S4 — the envelope**

- [ ] `gate-run`'s envelope states the stamped release, or states that none was stamped; and names
      WHICH gate it posted — `final` on a seal, and no gate at all on a hold.

  **Narrowed 2026-09-10 at cycle 403.** The criterion used to say "`interim` vs `final`". `interim` is
  unproducible in this CR: the interim POST is unreachable until CR-CRU-117 repairs the guard, so a
  fixture asserting it could only pass by mocking the very call this CR must not touch. The field is
  asserted with its two REACHABLE states, and CR-CRU-117 inherits the `interim` value along with the
  guard that makes it happen.
- [ ] When the run is still in flight the envelope says so, and `ok` is false.

**Integration**

- [ ] After this CR, each client's `_post_gate` forwards the release to the shared `post_gate` — a
      grep for the new argument returns ≥1 non-test caller per client, and VERIFY runs that grep
      itself.

  **Corrected 2026-09-10 (gap analysis).** The seam is `_post_gate`, not `cmd_gate_*`: all five
  `cmd_gate_run`/`cmd_gate_report` wrappers are single-statement delegators (CR-CRU-054's DRY rule)
  and spell no payload parameters, so a grep there would find nothing — the same trap that forced
  CR-CRU-114's identical AC to be rescoped. `_post_gate(project_dir, agent_id, gate, context=None)`
  DOES spell its parameters in all five clients and is the injected ops seam each client's harness
  patches, so the count is genuinely assertable there.
- [ ] `git diff --stat -- src public` is empty at close: the server already stores `version` and
      already retires by it; this CR only makes the fleet reach that mechanism.

## Estimated size

One cycle. `clients/_crucible_axi.py` (`cmd_gate_run`, `cmd_gate_report`, `post_gate`,
`gate_from_axi`, the gate verbs' flag surface) plus the five wrappers; tests under `tests/client/`.

## Risk

- **A gate is the release workflow's tracked trace**, so a bug here is invisible until a release runs.
  The §S2 and §S3 ACs are driven from snapshots captured verbatim from the 2026-09-09 run rather than
  hand-written shapes, so the fixtures cannot drift into agreement with the defect.
- `--release` is optional by design. An AC asserts the absent-key case precisely because a client that
  starts sending `version: null` would make every gate unretirable in a different way.
- The false `passed` gate already on this project's board (`evt-1788925414091-197`) carries no
  `version` and therefore cannot be retired by 0.2.0's release. Correcting that single event is a data
  decision for the orchestrator, not an AC of this CR.
- **Stamping `version` changes a gate's RETENTION, measured 2026-09-10.** `src/store.ts` defines a
  live gate as `kind = 'gate' AND retired_at IS NULL AND json_extract(payload, '$.version') IS NOT
  NULL` and exempts it from pruning. Today no gate carries `version`, so every gate is prunable;
  after this CR a release-stamped gate is retention-protected until its release records. A release
  that is proposed and never ships therefore leaves a permanently live gate — correct behaviour (it
  IS an unfinished release), but a new one, and it is why `--release` stays optional.
- **The fleet's existing interim fixtures encode a shape the real tool never emits.** The four
  per-client axi suites and bun's gates suite drive PROGRESSIVE snapshots of 3, then 6, then 8 rows;
  the real `axi status` always emits nine with unrun steps `pending`. That agreement between fixture
  and guard is why fault 1 survived to a release. This CR changes none of them (it no longer touches
  the guard), and CR-CRU-117 inherits the obligation to drive the real nine-row shape.

## Non-goals

- No new milestone type and no "release started" route: the gate is the carrier, per the DN.
- No change to the poll cadence, to `no-mistakes` itself, or to which pipeline steps a project skips.
- No retroactive repair of previously posted gates.
