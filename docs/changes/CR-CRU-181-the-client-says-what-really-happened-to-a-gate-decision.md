# CR-CRU-181 — the client says what really happened to a gate decision and a release

**Type** fix (patch CR, after the 0.3.0 release) · **Points** 5 (confirmed at gap analysis
2026-10-12) · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-10 (user
ruling: the 0.3.0 follow-ups are patch CRs in wave 8)

## Problem

Found while releasing 0.3.0 (2026-10-10), and by Model B's first use of 0.3.0 (Sandesh #1435).

1. **A gate decision that no-mistakes accepted is reported, and left unrecorded, as refused.**
   `gate-respond --action approve --step review` drove run `01M4HEHR…` past review; its wait (8 m)
   then ran out during the test step. no-mistakes answered the elapsed wait with a snapshot that names
   no run and carries `error: wait of 8m0s elapsed while driving the run`. `gate_decision_recorder`
   reads "names no run" as a refusal:
   - it printed `REFUSED: no-mistakes recorded no decision`, with `decision: none`;
   - it posted no decision. The store holds a decision for the release's second gate run
     (`01M4HR4P…`, where the wait did not run out) and none for `01M4HEHR…`.

   A real refusal looks the same on the wire: `--reason` on a review approval was refused at once,
   also with a snapshot that names no run. What tells the two apart is whether the step the decision
   answered is still awaiting approval afterwards.
2. **The held report does not say how to reattach.** A held run's report ends "inspect with `axi
   status` and reattach". Reattaching is `gate-run`, which requires `--intent`, and the report names
   neither.
3. **A gate run's later snapshots lose its release.** `gate-run --release X` stamps every snapshot it
   posts with `version: X`. `gate-respond` takes no release, so the snapshots it posts while driving
   the same run carry none. 0.3.0's final seal (run `01M4HR4P…`, pushed `740b642`) and seven interim
   snapshots are stored with no release; History lists the seal under 0.3.0 only because its
   timestamp falls in 0.3.0's window.
4. **`history --release X` calls a release the project holds "unknown".** History lists a release
   once it has shipped or has at least one completed CR. A planned release with neither is held by
   the project, through its queue rows or a release proposal, yet `history --release 1.1.0` refuses
   with `unknown release: 1.1.0` and the help line "history — lists every release label the project
   holds", which is false for that release.

## Steps

### §S1 — an accepted decision is recorded, and reported as accepted

Before launching `no-mistakes axi respond`, `gate-respond` reads `no-mistakes axi status` once. That
read names the run and the step awaiting approval, which is the step the decision answers when
`--step` is omitted. After respond exits, the client judges the decision by that step's status. A snapshot that shows
the step moved on (the respond's own answer, or the drive's last streamed snapshot) settles it.
Otherwise one more `axi status` read decides, because a streamed snapshot can predate the decision:

- **Accepted** (the step is no longer awaiting approval): the decision is recorded against the run,
  whether or not the respond's own answer named it. An exit whose run is still going is then a held
  exit, reported as the held report reports any held run.
- **Refused** (the step is still awaiting approval): nothing is recorded, as today.

The held report's help names the reattach command: `gate-run --intent "<intent>"`, plus `--release
<label>` when the drive knew one.

### §S2 — a run's snapshots keep the run's release (server)

When the board stores a gate snapshot with no `version` whose `gate.run.id` names a run, it stores
the snapshot under the `version` that the latest earlier snapshot of the same run in the same
project carries. A snapshot that names no run, or whose run has never carried a release, stays
release-less: nothing is derived from a branch or a timestamp. A snapshot that carries its own
`version` keeps it.

### §S3 — `history --release` tells a planned release from an unknown one

When the label is not among History's releases, the client checks whether the project holds it:
named by any queue row (`GET …/queue`), or by a live release proposal (`GET …/release-proposals`).

- **Held but not listed:** an error naming why ("not in History yet: nothing shipped and no CR
  completed"), and a help entry naming `queue --fields release,seq,points,dependsOn`.
- **Not held:** stays `unknown release: <label>`.

These reads happen on the refusal path only.

## Acceptance criteria

- [x] **Accepted after an elapsed wait.** For EACH of the five clients (`bun`, `python`, `mvn`,
      `rust`, `arduino`), against a fake no-mistakes whose status shows the run awaiting approval at
      `review` before the respond, and whose respond answer names no run (an elapsed wait) while
      status then shows `review` completed and `test` running:
      - the board holds exactly one decision, for that run with `step: review` and the respond's
        action;
      - the envelope carries `decision: <that id>` and `inFlight: true`;
      - the exit is the held exit (non-zero, nothing sealed).
- [x] **`--step` omitted.** Same setup, with `--step` omitted: the recorded decision's `step` is
      `review`, taken from the status read before the respond.
- [x] **Refused.** For EACH of the five clients, with status still showing `review` awaiting
      approval after the respond: no decision is posted, the envelope carries `decision: none`, and
      the exit is non-zero.
- [x] **Held report.** Every held exit of `gate-run` and `gate-respond` prints a help line containing
      `gate-run --intent`, and also `--release <label>` when the drive was given one.
- [x] **Server inheritance.** Through `POST /api/v2/gates`:
      - a release-less snapshot whose `gate.run.id` matches an earlier snapshot stored with
        `version: 0.4.0` is stored with `version` `0.4.0`;
      - a release-less snapshot of a run no snapshot gave a release is stored with none;
      - a snapshot that names no run is stored with none;
      - a snapshot carrying its own `version` keeps it, and runs in another project are never read.
- [x] **End to end.** `gate-run --release 0.4.0` followed by `gate-respond` on the same run (one
      client, against a live in-process board): every snapshot the respond posts, and its seal, is
      stored with `version` `0.4.0`.
- [x] **History, held label.** For EACH of the five clients, `history --release <label>` for a label
      named only by a queue row, and for a label named only by a live release proposal, exits 1. The
      error contains `not in History yet`, and a help entry names `queue`.
- [x] **History, unknown label.** For a label the project does not hold, the error stays
      `unknown release: <label>`.
- [x] **No new CR literals.** No CR-shaped literal is added to comments under `clients/` or `src/`,
      and the citation tripwire's pins are unchanged.

## How it is worked

On a feature branch, one cycle per step (§S1–§S3), RED first, then verify. The client changes live
in the shared module (`clients/_crucible_axi.py`), which all five clients' `gate-respond`,
`gate-run` and `history` verbs already call; the server change is in gate ingest.
