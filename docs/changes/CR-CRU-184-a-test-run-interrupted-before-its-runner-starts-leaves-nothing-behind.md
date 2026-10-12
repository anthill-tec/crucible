# CR-CRU-184 — a test run interrupted before its runner starts leaves nothing behind

**Type** fix (patch CR, split from CR-CRU-181 at its gap analysis) · **Points** 3 (set at filing,
2026-10-12) · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-181 · **Status** PENDING — filed 2026-10-12
(user ruling)

## Problem

Found at CR-CRU-181's gap analysis (2026-10-12), by reading the code after CR-CRU-180 fixed the same
class of gap for `gate-run`.

A test-family verb opens two things on the board before its runner starts: the gated-run identity
(`gated_run`, the shared bracket) and the run (`/runs/start`). Its SIGINT/SIGTERM trap
(`abandon_trap`) is installed only around the runner subprocess (in `bun-crucible.py`: `test` at the
`_run_logged` call, `regression` likewise; the other clients follow the same shape). A signal before
that point is not trapped:

- **SIGTERM** takes its default disposition and kills the process outright. No `finally` runs, so
  the identity stays registered (tombstoned by liveness after 5 minutes, removed after an hour), and
  an opened run waits for the server's auto-abort.
- **SIGINT** raises `KeyboardInterrupt`. The bracket's `finally` runs, but an identity whose opening
  heartbeat was still in flight has not been recorded, so nothing is removed.

## Steps

### §S1 — the trap covers the whole bracket

The shared `gated_run` bracket installs the trap for its whole body, and opens the identity inside
the trap's `held()` span, as `gate-run`'s run identity does. A signal anywhere in the bracket:

- closes the identity;
- aborts the run when `/runs/start` has opened one (`abort_run`, reason naming the signal);
- exits with 128+signum and one `ok: false` envelope naming the signal, through the same path a
  signal during the runner already takes.

## Acceptance criteria

- [ ] For EACH of the five clients and EACH verb that runs inside `gated_run` (enumerated at RED,
      e.g. `test`, `regression`, `pre-merge-gate`, mvn's tier verbs, rust's gate verbs), signalled
      with SIGINT and with SIGTERM while the identity's opening heartbeat is held (the recording
      board's held-reply seam):
      - the identity is removed (one removal);
      - no run is left open;
      - the exit is 128+signum.
- [ ] The same, signalled while `/runs/start`'s reply is held: the run is aborted with a reason
      naming the signal, the identity is removed, and the exit is 128+signum.
- [ ] A signal during the runner behaves exactly as today. Every existing interrupt test passes
      unchanged.
- [ ] No CR-shaped literal is added to comments under `clients/`.

## How it is worked

On a feature branch: RED (the held-reply interrupt cases above, failing today), GREEN in the shared
bracket, then verify.
