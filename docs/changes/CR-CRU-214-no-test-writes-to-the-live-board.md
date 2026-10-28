# CR-CRU-214 — no test writes to the live board

**Type** fix · **Points** 2 · **Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-28
(found 2026-10-28 behind CR-CRU-213; user ruling: a patch CR into 0.4.0, sequenced next; gap analysis
pending)

## Problem

`tests/client/test_cr040_coverage_tooling.py`'s `CovSourceDefaultTest` checks the `--cov-source` default
by running the python client's real `main()` with `regression` and `pre-merge-gate --agent
cr040-red-probe`, with the verb's handler mocked. But the shared dispatch wrapper (`run_verb` in
`clients/_crucible_axi.py`) posts a gate's outcome milestone **after** the handler returns, and the
client resolves its project and board from the repo's own `.env` and `crucible.toml` — the live
Crucible project on the dev board. So every full python run (every pre-merge gate and every VERIFY run)
registers `cr040-red-probe` in the live project and files an unlabelled `pre-merge-gate` milestone there.

Measured on the dev board 2026-10-28: since 2026-10-14 (CR-CRU-188, which added that post), 83
`cr040-red-probe` lifecycle records and 77 stray `pre-merge-gate` milestones in the live project. No other
test identity writes there. Nothing guards against a test reaching the live board this way.

## Design (proposed — to be settled at gap analysis)

- **The test reaches no board.** `CovSourceDefaultTest` reads the parsed default without running the
  verb's tail — by parsing only, or by steering the client to a throwaway board — so it posts nothing.
- **A guard keeps it so.** A standing test fails when a client test drives a client's `main()` or a
  client subprocess with the repo root as its project (the live `.env`) and no fixture board.
- **The live project's stray records** (`cr040-red-probe` registrations, the unlabelled
  `pre-merge-gate` milestones) are left as history, or removed, as the gap analysis decides.

## Acceptance criteria (draft — fixed at gap analysis)

- [ ] **AC1** A full python client-suite run against a board leaves no record from any test identity in
  the project the repo's `.env` names.
- [ ] **AC2** The `--cov-source` default checks still hold, posting nothing.
- [ ] **AC3** The guard fails on a planted test that drives a client's `main()` from the repo root with
  no fixture board, and passes on the tree after the change.

## Non-goals

- The CR-CRU-188 rule that a gate test opens no live store (already guarded).

## Release notes

- The client suite no longer writes to the live board: a `--cov-source` test had registered an agent and
  filed a stray gate milestone in the project on every full run; a guard keeps tests off the live board.
