# CR-CRU-217 — the rust gate lock of a project outside git is its own

**Type** fix · **Points** 3 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-29
(found at CR-CRU-215's spec pre-review, F6; user ruling: its own CR, sequenced after CR-CRU-215)

## Problem

The rust client takes a gate lock for a gated run (`_acquire_gate_lock` in `clients/rust-crucible.py`) at the
path `_gate_lock_path` resolves: the parent of the project's git common directory, so every worktree of one
repository shares one lock. For a project directory that is not a git repository both `git rev-parse` calls
print nothing, and the fallback (`os.path.abspath(os.path.join(project_dir, ""))`) takes the project directory
itself for the common directory — so the lock lands in its **parent**. Every non-git project under one
directory shares a lock there: a scratch project under `/tmp` locks `/tmp/nai-gate.lock`.

Measured 2026-10-29 at CR-CRU-215's pre-review: `_gate_lock_path('/tmp/tmpstdizzr9')` returns
`/tmp/nai-gate.lock`, and a test drive's stderr read `reclaiming stale gate lock … gate lock created at
/tmp/nai-gate.lock`. Two consequences:

- Concurrent rust drives from different non-git scratch directories — two test suites on one host, a Track's
  and Mainline's — refuse each other (exit 75, "REFUSING to start") or reclaim each other's lock.
- A drive run in-process (`tests/client/test_client_tier_stamping.py`'s `drive_with_real_std` runs `main()` in
  the test process) leaves the lock held under the test runner's pid, with its atexit hook and its
  SIGTERM/SIGINT/SIGHUP handlers installed in the runner, until that process exits.

A real cargo project that is not a git repository shares the same lock with its sibling directories.

## Design

A project that is not a git repository has no worktrees to share a lock with: its lock is its own. The open
question for the gap analysis — whether it is project-local (inside the project directory) or no lock at all —
is settled there against what the gate-lock contract (`~/.agents/scripts/gate-lock.sh`, `contracts/gate-lock.md`)
says for a project outside git.

## Steps

### §S1 — the lock path of a project outside git

`_gate_lock_path` no longer resolves a non-git project directory to its parent: such a project's gated run
locks its own path, or none, per the Design.

### §S2 — an in-process drive leaves nothing behind

A gated run that `main()` runs in a process that outlives it releases its lock and restores the signal
handlers it installed when the run ends, not when the process exits.

## Acceptance criteria

- [ ] **AC1 — no shared parent.** For a project directory that is not a git repository, the gate lock path is
      not in its parent directory; two such projects under one directory get different paths (or none).
- [ ] **AC2 — a repository is unchanged.** For a git repository and for each of its worktrees, the path is the
      parent of the common git directory, as today.
- [ ] **AC3 — two drives do not collide.** Two gated rust runs from two non-git scratch directories under one
      parent, overlapping in time, both run; neither is refused for the other's lock.
- [ ] **AC4 — nothing left in-process.** After an in-process gated run returns, no lock it created remains and
      the process's SIGTERM, SIGINT and SIGHUP handlers are the ones it had before.

## Non-goals

- The gate-lock contract for git repositories, and the other clients' locks.
- CR-CRU-215's whole-second report race.
