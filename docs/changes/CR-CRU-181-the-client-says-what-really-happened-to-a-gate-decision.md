# CR-CRU-181 — the client says what really happened to a gate decision and a release

**Type** fix (patch CR, after the 0.3.0 release) · **Points** 5 (set at filing, 2026-10-10) ·
**Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-10 (user ruling: the 0.3.0
follow-ups are patch CRs in wave 8)

## Problem

Found while releasing 0.3.0 (2026-10-10), and by Model B's first use of 0.3.0 (Sandesh #1435).

1. **A gate decision that no-mistakes accepted is reported, and left unrecorded, as refused.**
   `gate-respond --action approve --step review` drove the run past review, then its wait (8 m) ran
   out during the test step. no-mistakes' answer to the elapsed wait names no run, so
   `gate_decision_recorder` (`clients/_crucible_axi.py`) took the refusal branch:
   - it printed `REFUSED: no-mistakes recorded no decision — its answer names no run: wait of 8m0s
     elapsed while driving the run`, exit 1, `decision=none`;
   - it posted no decision to the board.

   But no-mistakes had recorded the approval: `axi status` showed review `completed`. So the board
   lacks a decision that was taken, and the operator is told the opposite of what happened. The
   recorder's own contract says "an elapsed wait is not a failed run".
2. **`gate-respond` cannot say which release a gate belongs to.** `gate-run --release X` stamps its
   snapshots, but `gate-respond` has no `--release`. The snapshots it posts while driving the run
   carry `release: unstated`, so a release gate's later snapshots lose the release its first ones
   carry.
3. **`history --release X` calls a release the project holds "unknown".** History lists a release
   once it has shipped or has at least one completed CR. A planned release with neither is held by
   the project, and `queue` lists its CRs, but `history --release 1.1.0` refuses with
   `unknown release: 1.1.0` and the help line "history — lists every release label the project
   holds", which is false for that release.
4. **The test-family verbs may orphan their run identity on an early signal.** CR-CRU-180 found that
   a SIGINT/SIGTERM landing while `gate-run`'s run identity was being opened (its first heartbeat in
   flight) left the identity on the board, and fixed it for `gate-run` only (`AbandonTrap.held()`).
   `gated_run`, which the test and regression verbs use, opens an identity the same way and has not
   been checked.

## Steps

### §S1 — an accepted decision is recorded, and reported as accepted

When no-mistakes' snapshot names no run but the decision was taken (the step it answered is no
longer `awaiting_approval`), the client finds the run from no-mistakes' own status and records the
decision against it. It reports the decision as recorded, and the run as still in flight with the
reattach step (`gate-run … --intent …`). A refusal that left the step awaiting approval stays a
refusal, with nothing recorded.

### §S2 — `gate-respond` takes the release

`gate-respond --release <label>` stamps every snapshot it posts with the release, as `gate-run
--release` does. Omitted, the client reads the release from the run's earlier snapshots on the
board, so a release gate never loses its release mid-run.

### §S3 — `history --release` tells a planned release from an unknown one

A label the project holds as a release (registered, or named by any queue row) but that History does
not list yet is answered with an error naming why ("not in History yet: nothing shipped and no CR
completed"), and a help line pointing at `queue --fields release,seq,points,dependsOn`. Only a label
the project does not hold at all is "unknown".

### §S4 — the test-family verbs survive an early signal

Establish whether `gated_run` has the gap `gate-run` had, reproducing it with the recording board's
held-reply seam (`tests/client/live_run_harness.py`). If it does, it is fixed the same way, failing
test first. If it does not, the test that proves it stays as a regression.

## Acceptance criteria

- [ ] With no-mistakes answering an elapsed wait with a snapshot naming no run, and its status
      showing the answered step past `awaiting_approval`: `gate-respond` exits 0, its envelope
      carries `decision: <id>` (not `none`), and the board holds one decision for that run and step.
- [ ] With the step still `awaiting_approval` after the answer: exit non-zero, `decision: none`, and
      no decision posted.
- [ ] `gate-respond --release 0.4.0` posts snapshots whose `release` is `0.4.0`; without the flag, a
      run whose `gate-run` snapshots carry `0.4.0` gets `0.4.0` on `gate-respond`'s snapshots too.
- [ ] `history --release <label>`, for a label held by a queue row but not listed by History,
      exits 1 with an error containing `not in History yet` and a help entry naming `queue`; for a
      label the project does not hold, the error stays `unknown release: <label>`.
- [ ] Each test-family verb (`test` in all five clients, plus bun `e2e`), signalled (SIGINT and
      SIGTERM) while its identity's opening heartbeat is held, removes its identity: one removal
      and exit 128+signum.

## How it is worked

On a feature branch. One cycle per step (§S1–§S4), RED first, then verify. Each change is mirrored
in all five clients through the shared module.
