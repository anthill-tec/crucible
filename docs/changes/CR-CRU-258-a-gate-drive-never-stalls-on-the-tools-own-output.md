# CR-CRU-258 — a gate drive never stalls on the tool's own output

**Status:** PENDING · filed 2026-11-15 (found by the 0.4.0 release's own no-mistakes run; user ruling: planned into
0.5.0, so 0.4.0 ships with it)
**Type:** fix
**Points:** 2
**Wave:** 9 (0.5.0)
**Depends on:** —
**Labels:** client, gate, release
**Design reference:** `test-reports/work/cr258-gap-analysis.md` (D1–D8, approved 2026-11-15); CR-CRU-221 (the
core's headroom)

## Problem

`gate-run` and `gate-respond` launch no-mistakes (`axi run`, `axi respond`) with its stdout and stderr on pipes. While
the run is in flight they poll `axi status` and post interim gates, but they read neither pipe until the tool has
exited. A pipe holds 64 KiB. When the tool prints more than that, it blocks on the write and never exits, and the
client never reads, so both wait for ever.

On `release/0.4.0` the run `01M7E2AA` stopped at its review gate with a 65,672-byte snapshot, because a rebase finding
listed 484 commits. The run itself went on to pass, but `bun-crucible.py gate-run` stayed blocked for 63 minutes,
until the pipe was drained by hand. It then reported "`axi run` produced no parseable final snapshot" and sealed
nothing.

Every client shares this drive (`drive_axi_run` in the core), and it has shipped since 0.3.0. Any run whose snapshot
passes 64 KiB, such as a long-lived branch or a review with many or long findings, hangs its caller.

## Behaviour

- **S1 — the tool's output is never left to fill.** A drive launches no-mistakes so that nothing it writes can
  block it:
  - its stdout goes to a sink with no fixed capacity (an anonymous temporary file), which the drive reads once the
    tool has exited;
  - its stderr is discarded (`DEVNULL`), as its content already is.
- **S2 — everything else is unchanged:**
  - the poll loop, its cadence and the ladder dedup;
  - the interim gates and the final seal;
  - the relay of the tool's snapshot to the caller's stdout;
  - the envelope;
  - the SIGINT/SIGTERM trap and the run identity.
  A final snapshot of any size is decoded and sealed exactly as a small one is now.
- **S3 — where it lives.** The launch and the read after exit are one helper in `_crucible_run.py`, the module
  that owns runner launches. `drive_axi_run` calls it, so the core gets shorter. The core keeps CR-CRU-221's
  headroom (at most `CORE_LINE_LIMIT − CORE_HEADROOM_LINES` lines), and the run module's line budget is
  re-recorded in each `SHARED_MODULE_LINE_BUDGETS` copy.

## Acceptance criteria

- **AC1** — `gate-run`'s `axi run` prints a well-formed final snapshot of at least 256 KiB, then exits. `gate-run`
  returns on its own within a bounded time, seals the outcome that snapshot states, relays it to its stdout and
  exits 0.
- **AC2** — the same for `gate-respond`, whose `axi respond` prints a final snapshot of at least 256 KiB.
- **AC3** — a tool that writes at least 256 KiB to stderr before a small final snapshot does not stall either drive.
  Both return and seal as AC1 says.
- **AC4** — the existing suites for gate-run, gate-respond, the skip declaration, interrupts and the run identity
  pass unchanged.
- **AC5** — the core is at most `CORE_LINE_LIMIT − CORE_HEADROOM_LINES` lines. Every `SHARED_MODULE_LINE_BUDGETS`
  copy records the core's and the run module's new counts.
- **AC6** — `CHANGELOG.md`'s `## [Unreleased]` section carries a `### Fixed` entry saying that `gate-run` and
  `gate-respond` no longer hang when no-mistakes prints more than 64 KiB.

Every new test drives a fake `no-mistakes` on a scratch PATH, never the real one, and runs the client under a
`subprocess` timeout. On today's code it therefore fails on that timeout and never hangs the suite.

## Non-goals

- Relaying no-mistakes' stderr to the caller. Today it is captured and then dropped, and that does not change.
- Changing the poll cadence, the interim throttle or the envelope.
