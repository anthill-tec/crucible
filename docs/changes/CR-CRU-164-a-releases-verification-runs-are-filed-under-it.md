# CR-CRU-164 — a release's verification runs are filed under the release

**Type** feature · **Points** 8 (re-scored at gap analysis 2026-10-07; was 5) · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-157 · **Status** PENDING — filed 2026-10-01; amended at gap analysis 2026-10-07 (user-approved)

## Problem

**Request from Sandesh (#1412, 2026-10-01).** A release's verification (e.g. a full regression on
`release/X.Y.Z`) runs outside any cycle, so the client warns `no-cycle` and the run is filed against
the project only. The evidence that a release was verified cannot be asked for by release.

**Measured 2026-10-01:** `--release` exists on the gate verbs and `plan-file` (the shared help texts
in `clients/_crucible_axi.py`), not on the test-run verbs.

**Measured 2026-10-07 (gap analysis):** `gate-run --release` does NOT refuse an undeclared release —
`handleGates` stores the label verbatim as the gate's `version`, and no route refuses an unknown
release label. The refusal below is new behaviour, not a copy of an existing one.

## Scope

### §S1 — `--release` on test runs

`--release X.Y.Z` is accepted by each of these verbs, beside `--cycle` where the verb has one
(corrected 2026-10-07 at C2 RED: python `test`, mvn `test` and its tier verbs, and rust `test`,
`smoke-test`, `workspace-regression` and `pre-merge-gate` take no `--cycle` today; they take
`--release` all the same, and adding `--cycle` to them is not this CR's scope): bun `test`, `regression`, `pre-merge-gate` and its declared-tier verbs;
python `test`, `regression`, `pre-merge-gate` and its tier verbs; mvn `test`, its tier verbs,
`regression` and `pre-merge-gate`; rust `test`, `regression-ingest`, `smoke-test`,
`workspace-regression` and `pre-merge-gate`; arduino `test`/`unit`/`regression` and `pre-merge-gate`.
It rides both the run start (`POST /api/v2/runs/start`) and the ingest that closes the run.

- **Declared release.** A release is declared when the project's roadmap knows it: a CR planned
  into it, a live release proposal, or a recorded release. An undeclared label is refused (400) and
  the refusal lists the declared ones; nothing is stored.
- **A cycle or a release, never both.** A cycle's runs are its CR's evidence; a release's runs are
  its verification. `--release` together with `--cycle`, or from an agent bound to a cycle, is
  refused (400) and nothing is stored.
- **Stored natively.** The release is a column on the run's event and on its open run row (so an
  aborted verification run is listed under its release too), added through the migration chain
  (schema v17 → v18) with an index on `(project_key, release, timestamp)` — not a key in the JSON
  context.
- **The note.** A run with `--release` makes no `no-cycle` warning; its envelope carries a
  `release-run` note naming the release instead.

Retention is unchanged: a verification run is an ordinary test run and may be evicted (user ruling
2026-10-07).

### §S2 — read by release

`GET /api/v2/events?project=<key>&release=X.Y.Z` answers that release's runs, newest first, in the
same brief shape as the list, aborted runs included. The roadmap's release band (zone 3 header,
`roadmap-progress`) carries a `verified · N runs ↗` chip when the focused release has any, which
opens the Runs tab filtered to that release (`?release=`, read through the route above, the way the
`cycleId` anchor is). On a phone the chip sits in the analytics pane instead, so the one-line band
does not overflow; a release with no runs shows no chip.

## Acceptance criteria

- [ ] For each verb named in §S1, in each of the five clients, `--release 0.4.0` files a run whose
      event and run row carry release `0.4.0`, and the envelope carries the `release-run` note and
      no `no-cycle` warning — asserted per client against the five-client subprocess harness, and
      once end to end against a real server.
- [ ] An undeclared release is refused (400) naming the declared ones; `--release` with `--cycle`,
      or from an agent bound to a cycle, is refused (400); in both cases nothing is stored —
      asserted on the server.
- [ ] A store at schema v17 migrates to v18 through the chain (backup written, existing runs carry
      no release, the index exists); a fresh store is built at v18.
- [ ] `GET /api/v2/events?project=…&release=X` answers exactly that release's runs, aborted ones
      included, and nothing else; the release band shows `verified · N runs ↗` with the right N
      for the focused release, none when N is 0, and opens the Runs tab showing exactly those runs;
      on a phone the chip is in the analytics pane — asserted on the server and in a real browser.
