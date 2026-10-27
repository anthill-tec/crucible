# CR-CRU-205 — a waiting client is recognised by its system call, not a kernel function name

**Type** fix · **Points** 1 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed
2026-10-27 (user ruling: its own CR, ahead of CR-CRU-152)

## Problem

**Measured 2026-10-27** on develop `db8137d`, after this machine's kernel moved to Linux 7.3 on
2026-10-24: the python suite is 4352 passed, 1 failed, every run.

The failing test proves that a signal reaching the client after its runner has closed its output,
but before the runner is reaped, still takes the runner's whole process group down. To land the
signal in that window, the test waits until the client is blocked waiting on its runner. The
shared test helper decides that by polling `/proc/<pid>/wchan` for the exact string `do_wait`.

`wchan` is the name of a kernel-internal function, and it is not stable across kernels. On Linux
7.3 the same wait reads `__x64_sys_wait4.cold`, so the helper never sees the client waiting, and the
test stops at its own precondition ("fixture failure: the client was never seen waiting on its
runner after the runner's output ended") without reaching the behaviour it tests. Every gate is red
until it is fixed.

## Design (user ruling, 2026-10-27)

The wait is recognised by the **system call** the process is blocked in, read from
`/proc/<pid>/syscall`, whose first field is the call's number: `wait4` and `waitid` (x86_64: 61 and
247; measured here, a process blocked in `wait()` reads `61`). Never by a kernel function name.

## Steps

### §S1 — the helper reads the blocked system call

The shared helper that waits for a process to block on a child reads `/proc/<pid>/syscall` and
returns once its first field is a wait-family call. Where that file cannot be read, the state
cannot be observed and the helper keeps today's fallback for an unobservable state: a short fixed
pause, then success. The numbers' architecture is stated where they are defined.

## Acceptance criteria

- [ ] **AC1 — the test runs again.** `tests.client.test_an_interrupted_runners_tree_is_taken_down_with_it`
      is 14 passed, 0 failed through the python client on this machine (13/1 before the fix), on
      three consecutive runs.
- [ ] **AC2 — no kernel function name.** The helper no longer reads `/proc/<pid>/wchan` or compares
      against any kernel function name; it decides from `/proc/<pid>/syscall`'s call number.
- [ ] **AC3 — the full suite.** The pre-merge gate is green, python included.

## Non-goals

- Any change to the clients or the behaviour the test proves.
- Platforms other than Linux: where the file is absent, the existing fallback applies, unchanged.
