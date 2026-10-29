# CR-CRU-217 — the rust gate lock of a project outside git is its own

**Type** fix · **Points** 2 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-29
(found at CR-CRU-215's spec pre-review, F6; user ruling: its own CR, sequenced after CR-CRU-215); gap
analysis 2026-10-29

## Problem

The rust client takes a gate lock for a gated run (`_acquire_gate_lock` in `clients/rust-crucible.py`, reached
by `workspace-regression`, `regression`, `pre-merge-gate`, `smoke-test` and `docker-e2e-gate`) at the path
`_gate_lock_path` resolves: the parent of the project's git common directory, so every worktree of one
repository shares one lock. The gate-lock contract (`contracts/gate-lock.md` in Model B, § "Lock path
derivation") states what a project outside git gets: Crucible's `_gate_lock_path` "has NO `/tmp` fallback — it
returns `None` and the run proceeds UNLOCKED", because "a non-git checkout must not silently share a lock with
an unrelated tree". `_acquire_gate_lock` already runs unlocked on `None`.

The code breaks that. When `git rev-parse --path-format=absolute --git-common-dir` prints nothing (no
repository), the older-git fallback runs anyway: the plain `--git-common-dir` prints nothing too, and
`os.path.abspath(os.path.join(project_dir, ""))` turns the project directory itself into the "common
directory" — so the lock lands in its **parent**. Every non-git project under one directory shares a lock
there: a scratch project under `/tmp` locks `/tmp/nai-gate.lock`.

Measured 2026-10-29 at CR-CRU-215's pre-review: `_gate_lock_path('/tmp/tmpstdizzr9')` returns
`/tmp/nai-gate.lock`, and a test drive's stderr read `reclaiming stale gate lock … gate lock created at
/tmp/nai-gate.lock`. Concurrent rust drives from different non-git scratch directories — two test suites on one
host, a Track's and Mainline's — refuse each other (exit 75) or reclaim each other's lock, and a drive run
in-process (`drive_with_real_std` runs `main()` in the test process) leaves the lock, its atexit hook and its
SIGTERM/SIGINT/SIGHUP handlers on the test runner.

## Design

The contract's answer: a project outside git has no gate lock — `_gate_lock_path` returns `None` and the run
proceeds unlocked. With no lock, nothing is installed in the process either, so an in-process drive leaves
nothing behind. A git repository and its worktrees are unchanged.

## Steps

### §S1 — `None` outside git

`_gate_lock_path` takes the older-git fallback only when `git rev-parse --git-common-dir` printed a directory;
when neither call prints one, it returns `None`.

## Acceptance criteria

- [ ] **AC1 — outside git, no lock path.** For a directory that is not a git repository, `_gate_lock_path`
      returns `None`; two such directories under one parent both return `None`.
- [ ] **AC2 — a repository is unchanged.** For a git repository and for a linked worktree of it,
      `_gate_lock_path` returns the parent of the common git directory joined with `nai-gate.lock`, as today.
- [ ] **AC3 — a run outside git takes no lock and leaves nothing.** A gated `workspace-regression` run from a
      non-git project directory, driven in-process, files its run, creates no `nai-gate.lock` in the project
      directory or its parent, and leaves the process's SIGTERM, SIGINT and SIGHUP handlers as they were.

## Non-goals

- The gate-lock contract for git repositories, Model B's `gate-lock.sh` (its `/tmp` fallback is its own), and
  the other clients.
- CR-CRU-215's whole-second report race.
