# CR-CRU-217 — the rust gate lock of a project outside git is its own

**Type** fix · **Points** 2 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** DONE — merged 2026-10-29 (plan 218, cycles 797–799,
gate 9292/0: bun 4226/0, python 5066/0); filed 2026-10-29 (found at CR-CRU-215's spec pre-review, F6; user
ruling: its own CR, sequenced after CR-CRU-215)

## Problem

The rust client takes a gate lock for a gated run (`_acquire_gate_lock` in `clients/rust-crucible.py`, reached
by `workspace-regression`, `regression`, `pre-merge-gate`, `smoke-test` and `docker-e2e-gate`) at the path
`_gate_lock_path` resolves: the parent of the project's git common directory, so every worktree of one
repository shares one lock. The gate-lock contract (`contracts/gate-lock.md` in Model B, § "Lock path
derivation") states what a project outside git gets: Crucible's `_gate_lock_path` "has NO `/tmp` fallback — it
returns `None` and the run proceeds UNLOCKED", because "a non-git checkout must not silently share a lock with
an unrelated tree". `_acquire_gate_lock` already runs unlocked on `None`, installing no lock, atexit hook or
signal handler.

The code breaks that. Outside a repository `git rev-parse --path-format=absolute --git-common-dir` prints
nothing, so the older-git fallback runs: the plain `--git-common-dir` prints nothing too, and
`os.path.abspath(os.path.join(project_dir, ""))` turns the project directory itself into the "common
directory" — so the lock lands in its **parent**. Every non-git project under one directory shares a lock there:
a scratch project under `/tmp` locks `/tmp/nai-gate.lock`. Concurrent rust drives from different non-git
scratch directories refuse each other (exit 75) or reclaim each other's lock, and a drive run in-process
(`drive_with_real_std` runs `main()` in the test process) leaves the lock, its atexit hook and its signal
handlers on the test runner.

That fallback cannot do the job it was written for either: git older than 2.31 (which added `--path-format`)
echoes the unknown option, so the first call's output is never empty there and the fallback never runs — it
runs only outside git, where it is the bug.

## Design (user rulings 2026-10-29)

- **No lock outside git**, as the contract states: `_gate_lock_path` returns `None` and the run proceeds
  unlocked. Nothing is installed in the process, so an in-process drive leaves nothing behind. The cost, on
  record: two gated runs in the same non-git directory are no longer stopped from running together (both clean
  and write the same `target/`) — the contract's "degraded, deliberately non-blocking"; every rust project the
  fleet runs is a git repository.
- **The older-git fallback is deleted**, not guarded. Model B is told, since the contract's "Older-git
  fallback" row and `gate-lock.sh` carry the same dead branch.
- **An unlocked run says so**: one stderr line, so a git checkout git refuses to read (dubious ownership, a
  missing `safe.directory`) is visible instead of silently unlocked.

## Steps

### §S1 — `None` outside git, the fallback gone

`_gate_lock_path` returns the parent of `git rev-parse --path-format=absolute --git-common-dir` joined with
`nai-gate.lock` when that call prints a directory, and `None` otherwise; the older-git branch is deleted. The
function stays self-contained — it uses only `os` and `subprocess` — because Model B's derivation-equality gate
(`tests/test_tooling_detachment.py`) extracts its body and runs it alone. Its docstring names the one difference
from `gate-lock.sh`'s `lock_path()`: outside git it is `None`, not `/tmp/nai-gate.lock`.

### §S2 — the unlocked run says so

When `_acquire_gate_lock` gets `None`, it prints one stderr line saying the run takes no gate lock because no
git repository was resolved for the project directory, and proceeds.

### §S3 — the comments that no longer hold

`tests/clients-rust-mvn-crucible.test.ts`'s comments that a git repository is "required for the gate-lock path
resolution" (the CR-CRU-050 workspace-regression case and the smoke case) say instead that `git init` keeps the
drive's lock private to its project.

## Acceptance criteria

- [x] **AC1 — outside git, no lock path.** For a directory that is not a git repository — under a private
      scratch parent, with `GIT_DIR`, `GIT_COMMON_DIR` and `GIT_WORK_TREE` removed from the environment, and
      `git rev-parse --git-common-dir` asserted to fail there first — `_gate_lock_path` returns `None`; two such
      directories under one parent both return `None`.
- [x] **AC2 — a repository is unchanged.** For a git repository and for a linked worktree of it,
      `_gate_lock_path` returns the parent of the common git directory joined with `nai-gate.lock`, as today;
      the function's body uses only `os` and `subprocess`.
- [x] **AC3 — a run outside git takes no lock and leaves nothing.** A gated `workspace-regression` run from such
      a non-git directory, driven in-process, files its run; afterwards no `nai-gate.lock` exists in the project
      directory or its parent, `_HELD_GATE_LOCK` is `None`, and none of the process's SIGTERM, SIGINT and SIGHUP
      handlers is `_gate_lock_signal`.
- [x] **AC4 — the unlocked run says so.** That run's stderr carries one line saying it takes no gate lock
      because no git repository was resolved; a run in a git repository carries no such line.

- *Recorded at merge:* VERIFY approved; its F1 was fixed in its own cycle (799, user ruling): a git older than
  2.31 echoes `--path-format=absolute` and exits 0, so `_gate_lock_path` takes git's answer only when it is one
  absolute line, and returns `None` for anything else — §S1's "prints a directory". Model B's derivation gate
  still holds for a main tree and a linked worktree (reproduced against the new body). The two existing tests
  that took `/tmp/nai-gate.lock` (`test_rust_regression_coverage_is_opt_in`, `RustEarnedTierTest`) now run
  unlocked. Model B was told (Sandesh 1496); its CR-MDB-052 item 15 drops the same dead branch from
  `gate-lock.sh` and the contract.

## Non-goals

- Model B's `gate-lock.sh` and its contract (told of the deleted fallback; theirs to change), and the other
  clients.
- CR-CRU-215's whole-second report race.
