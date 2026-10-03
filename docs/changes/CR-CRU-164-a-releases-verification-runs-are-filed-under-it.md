# CR-CRU-164 — a release's verification runs are filed under the release

**Type** feature · **Points** 5 (planning game 2026-10-03) · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-157 · **Status** PENDING — filed 2026-10-01

## Problem

**Request from Sandesh (#1412, 2026-10-01).** A release's verification (e.g. a full regression on
`release/X.Y.Z`) runs outside any cycle, so the client warns `no-cycle` and the run is filed against
the project only. The evidence that a release was verified cannot be asked for by release.

**Measured 2026-10-01:** `--release` exists on the gate verbs and `plan-file` (the shared help texts
in `clients/_crucible_axi.py`), not on the test-run verbs.

## Scope

### §S1 — `--release` on test runs

Every client's test-run verbs (`test`, `regression` and the declared-tier verbs) accept
`--release X.Y.Z`. The run is stamped with the release, the `no-cycle` warning is replaced by a note
naming the release, and the board refuses an undeclared release as `gate-run` does.

### §S2 — read by release

The board answers a release's verification runs (e.g. `GET /api/v2/events?project=…&release=X.Y.Z`),
and the release's roadmap entry links to them.

## Acceptance criteria

- [ ] `regression --release 0.4.0` files a run stamped with release `0.4.0`, without a `no-cycle`
      warning, for each of the five clients.
- [ ] An undeclared release is refused, naming the declared ones.
- [ ] The events read filters by release, and the release's roadmap entry links to its runs.
