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

### §S2 Interim gates are posted while the run is in flight

The interim POST's guard tests **whether the snapshot is terminal**, not how many rows it has. A
snapshot is non-terminal when it carries no resolved `outcome` and at least one step is still
`pending`, `running`, `fixing` or awaiting a decision. Under the existing cadence, a run that takes
minutes posts interim gates throughout it, and the nine-row shape that `axi status` always emits is
no longer read as "already resolved".

### §S3 A run that is still going is never sealed

A return whose snapshot carries no resolved `outcome` is a **hold**, not a terminus. `gate-run` then:
posts no gate claiming an outcome; reports the hold, naming the snapshot's own `error` when it carries
one; and states the reattach move. The step ladder still reaches the board as an interim gate, so the
hold is visible without being a verdict.

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

**§S2 — streaming**

- [ ] Given a snapshot with `steps[9]` where `review` is `running` and six steps are `pending` and no
      `outcome` key — the exact shape captured from a live run — `cmd_gate_run` posts an **interim**
      gate. Today's guard posts none; this is the reversal.
- [ ] Given a snapshot with `steps[9]` all `completed` and a resolved `outcome`, no interim gate is
      posted for it.
- [ ] The interim gate's `steps[]` carries all nine names with their mapped statuses, so `pending` is
      represented rather than dropped.
- [ ] Interim posts still obey the existing cadence: two snapshots within one cadence window produce
      one POST, asserted by counting POSTs.

**§S3 — no false seal**

- [ ] Given the bounded-hold return — `error: wait of 8m0s elapsed while driving the run`, no
      `outcome`, `review` at `awaiting_approval` — `cmd_gate_run` posts **no** gate whose `outcome` is
      `passed`, exits non-zero, and its stderr/envelope names the hold and the reattach move.
- [ ] `gate_from_axi(..., final=True)` on a snapshot with no `outcome` does not return `passed`:
      asserted for `pending`, `running`, `fixing` and `awaiting_approval` step states, all four.
- [ ] A snapshot with a resolved `outcome: passed` still seals `passed`, and one with a `failed` step
      still seals `failed` — the fix narrows the fallback without changing a real verdict.
- [ ] `passed-with-skips` — the outcome this release actually produced — seals verbatim and is not
      remapped.

**§S4 — the envelope**

- [ ] `gate-run`'s envelope states the stamped release, or states that none was stamped; and states
      `interim` vs `final` for the gate it posted.
- [ ] When the run is still in flight the envelope says so, and `ok` is false.

**Integration**

- [ ] After this CR, `cmd_gate_run` and `cmd_gate_report` in each of the five clients pass the release
      through to `post_gate` — a grep for the new argument returns ≥1 non-test caller per client, and
      VERIFY runs that grep itself.
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

## Non-goals

- No new milestone type and no "release started" route: the gate is the carrier, per the DN.
- No change to the poll cadence, to `no-mistakes` itself, or to which pipeline steps a project skips.
- No retroactive repair of previously posted gates.
