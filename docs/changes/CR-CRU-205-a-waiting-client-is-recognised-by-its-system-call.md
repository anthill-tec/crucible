# CR-CRU-205 — a waiting client is recognised by its system call, not a kernel function name

**Type** fix · **Points** 1 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** DONE — filed
2026-10-27 (user ruling: its own CR, ahead of CR-CRU-152); merged 2026-10-27 (plan 207, cycles 739–740, gate 8054/0)

## Problem

**Measured 2026-10-27** on develop `db8137d`, after this machine's kernel moved to Linux 7.3 on
2026-10-24: the python suite is 4352 passed, 1 failed, every run.

The failing test proves that a signal reaching the client after its runner has closed its output,
but before the runner is reaped, still takes the runner's whole process group down. To land the
signal in that window, the test waits until the client is blocked waiting on its runner. The
shared test helper decides that by polling `/proc/<pid>/wchan` for the exact string `do_wait`.

`wchan` is the name of a kernel-internal function, and it is not stable across kernels. On Linux
7.3 a process blocked in `wait4` (Python's `Popen.wait()`, which is how the client waits) reads
`__x64_sys_wait4.cold`; one blocked in `waitid` still reads `do_wait`. So the helper never sees the
client waiting, and the test stops at its own precondition ("fixture failure: the client was never
seen waiting on its runner after the runner's output ended") after its 10-second timeout, without
reaching the behaviour it tests. Every gate is red until it is fixed.

## Design (user ruling, 2026-10-27)

The wait is recognised by the **system call** the process is blocked in, read from
`/proc/<pid>/syscall`, whose first field is the call's number: `wait4` or `waitid`. Never by a
kernel function name. The numbers differ by architecture:

| `platform.machine()` | `wait4` | `waitid` |
|---|---|---|
| `x86_64` | 61 | 247 |
| `aarch64` | 260 | 95 |

Measured here: a process blocked in `Popen.wait()` reads `61`, in `os.waitid` `247`, and one sleeping
in `time.sleep` `230`.

## Steps

### §S1 — the helper reads the blocked system call

The shared test helper that waits for a process to block on a child (`tests/client/live_run_harness.py`)
polls `/proc/<pid>/syscall` and returns True once its first field is the `wait4` or `waitid` number
for the machine's architecture, per the table above. While the first field is not a number
(`running`) or is `-1`, the process is not waiting yet and polling continues; neither ever raises
or counts as waiting. At the timeout it returns False, as today.

The state cannot be observed, and the helper keeps today's fallback for that (a short fixed pause,
then True), when the file is absent, when it cannot be read (`PermissionError` or another
`OSError`), or when the architecture is not in the table. The helper's docstring describes the
system-call test and the table.

## Acceptance criteria

- [x] **AC1 — the test runs again.** `tests.client.test_an_interrupted_runners_tree_is_taken_down_with_it`
      is 14 passed, 0 failed through the python client on this machine (13/1 before the fix), on
      three consecutive runs.
- [x] **AC2 — the helper tells a wait from other blocking.** Direct tests of the helper, each on a
      child process it starts: a child blocked in `Popen.wait()` gives True; a child blocked in
      `os.waitid` gives True; a child sleeping in `time.sleep` gives False within a short timeout;
      an unreadable syscall file (injected, not pid 1) gives the fallback's True after its pause and
      raises nothing; an architecture outside the table gives the fallback.
- [x] **AC3 — no kernel function name.** The helper neither reads `/proc/<pid>/wchan` nor compares
      against any kernel function name; its docstring describes the system-call test and the table.
- [x] **AC4 — the gate.** `python3 clients/bun-crucible.py pre-merge-gate --agent vidushi --cycle
      <the plan's last cycle>` is green, the python suite included.

## Non-goals

- Any change to the clients or the behaviour the test proves.
- Platforms where `/proc/<pid>/syscall` does not exist: the existing fallback applies, unchanged.
