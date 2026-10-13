# CR-CRU-184 — a test run interrupted outside its runner leaves nothing behind

**Type** fix (patch CR, split from CR-CRU-181 at its gap analysis) · **Points** 5 (re-scored at gap
analysis, 2026-10-13; filed at 3) · **Wave** 8 (0.4.0) · **Depends on** CR-CRU-181 · **Status**
PENDING — filed 2026-10-12 (user ruling)

## Problem

Found at CR-CRU-181's gap analysis (2026-10-12), by reading the code after CR-CRU-180 fixed the same
class of gap for `gate-run`.

A test-family verb runs inside the shared gated-run bracket (`gated_run`). Inside it, the verb opens
the gated-run identity, opens the run on the board (`/runs/start`), runs the runner, then ingests the
results. Its SIGINT/SIGTERM trap (`abandon_trap`) is installed only around the runner subprocess, and
only when `/runs/start` returned a run. Everything else is untrapped:
- **SIGTERM** takes its default disposition and kills the process outright. No `finally` runs, so
  the identity stays registered (tombstoned by liveness after 5 minutes, removed after an hour). An
  opened run waits for the server's auto-abort, and an ingest cut short leaves the run half-filed.
- **SIGINT** raises `KeyboardInterrupt`. The bracket's `finally` runs, but an identity whose opening
  heartbeat was still in flight has not been recorded, so nothing is removed.

The spans are:
1. from the identity's opening through `/runs/start`;
2. the runner itself, when `/runs/start` opened no run (`--no-lifecycle`, or a board that refused
   it);
3. the ingest, after the runner exits.

## The call sites

The bracket is entered at 13 call sites. Every verb below, every declared tier routed through them
(`_run_declared_*`), and arduino's `pre-merge-gate` whole-suite run reach one of them:

| Client | Call site (verb) |
|---|---|
| `bun` | `cmd_test` (`test`, declared tiers) · `cmd_regression` (`regression`, `pre-merge-gate`, declared scripts) |
| `python` | `cmd_test` (`test`, declared tiers) · `cmd_regression` (`regression`, `pre-merge-gate`) |
| `mvn` | `_run_surefire_tier` (`unit`, `module`, declared profiles) · `_run_failsafe_tier` (`integration`, `e2e`) · `cmd_regression` · `cmd_test` |
| `rust` | `cmd_regression_ingest` · `cmd_test` · `cmd_smoke_test` · `cmd_workspace_regression` |
| `arduino` | `_run_native_tests` (`test`, `unit`, `regression`, `pre-merge-gate`, declared targets) |

## Steps

### §S1 — the trap covers the whole bracket

When the bracket opens an identity (an `--agent` is given), it installs the trap for its whole body,
and opens the identity inside the trap's `held()` span, as `gate-run`'s run identity does. A signal
anywhere before the ingest:
- removes the identity;
- aborts the run when `/runs/start` has opened one (`abort_run`, with a reason naming the signal);
- exits with 128+signum and one `ok: false` envelope naming the signal, through the client's existing
  abandoned-run path.

Without an `--agent`, nothing is opened, and the default disposition stands.

### §S2 — the ingest is held

The ingest runs inside `held()`. A signal during it is noted, and the ingest finishes and files the
run. Then the identity is removed and the client exits with 128+signum and one `ok: false` envelope
naming the signal, which also reports the filed run. The results the runner earned are kept.

## Acceptance criteria

Every case below runs a REAL client subprocess against the recording board, using its held-reply seam
(`hold_next_reply`) and each stack's fake runner (`tests/client/live_run_harness.py`).

- [ ] **Opening, every call site.** For EACH of the 13 call sites above (one verb per site), SIGTERM
      sent while the identity's opening heartbeat is held:
      - the identity is removed (one removal);
      - no run is left open;
      - the exit is 143 and the envelope names `SIGTERM`.
- [ ] **Opening, both signals.** For EACH of the five clients (its `test` verb), the same with SIGINT
      (exit 130) and with SIGTERM.
- [ ] **Run opening.** For EACH of the five clients (`test`), SIGINT and SIGTERM sent while
      `/runs/start`'s reply is held:
      - the run is aborted with a reason naming the signal;
      - the identity is removed;
      - the exit is 128+signum.
- [ ] **No run opened.** For EACH of the five clients (`test`), with `/runs/start` refused by the
      board, SIGTERM during the runner removes the identity and exits 143.
- [ ] **Ingest held.** For EACH of the five clients (`test`), SIGTERM sent while the ingest's reply
      is held:
      - the run is filed with the runner's results and is not aborted;
      - the identity is removed;
      - the exit is 143 and the envelope names `SIGTERM` and the run id.
- [ ] **Runner unchanged.** A signal during the runner of an opened run behaves exactly as today, and
      every existing interrupt test passes unchanged.
- [ ] **No new CR literals.** No CR-shaped literal is added to comments under `clients/`, and the
      citation tripwire's pins are unchanged.

## How it is worked

On a feature branch: RED (the held-reply interrupt cases above, failing today), GREEN in the shared
bracket and the 13 call sites, then verify.
