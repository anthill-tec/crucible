# CR-CRU-150 — `status` shows the work in flight, not the project's history

**Type** feature · **Points** 13 · **Wave** 7 (0.3.0), before CR-CRU-149 (user ruling 2026-09-24) · **Depends on**
CR-CRU-030, CR-CRU-035, CR-CRU-094 · **Status** PENDING — filed 2026-09-24

## Problem

**Reported by Model B (Sandesh #1389, 2026-09-24), reproduced here.** `status` returns every plan
the project has ever filed. On this board on 2026-09-26 that is 142 plans: 133 `closed`,
9 `aborted`, **0 `open`**. One `status` read takes about a second and 132 KB, all of it history.
Model B measured `plans[31]`, mostly closed, against production.

**This is not a defect in the verb.** CR-030 §S6, the verb's origin, asks for "the queue table
(`cr`, `wave`, `status`, active cycle, `mergeCommit`) plus `lastRunCr`", which is every plan, and
`cmd_status` has passed `GET …/plans` through unfiltered since then. `STATUS-CONTRACT.md` says
"one uniform row per **open** plan". That sentence was written by CR-035, whose spec described the
verb as "already degrades on no open plan (… empty envelope)", which it never did. The contract's
own row schema (`status`: "`open` / closed", a `mergeCommit` column) still describes every plan.

**It is a design problem.** `status` is the verb CR-035 made safe for **session-start hooks**, so
every session start pays for, and prints, the whole history:

- **The output is unbounded.** It grows by one row per CR, forever, into a surface whose job is
  "what is in flight".
- **The read is the expensive one.** `GET …/plans` returns closed plans with the derived
  `commitBoundary`, the per-plan derivation CR-CRU-126 measured as the plan read's cost.
- **Consumers filter it themselves.** Model B's CR-MDB-019 hook drops `status == closed` on its
  side.

**User rulings.** 2026-09-24: scope `status` to open plans. 2026-09-26: the filter runs on the
**server**, and "never filed" is told from "none open" by a **key-value field** a program can test,
not by `help[]` or `warnings[]` text, which are AXI's surfaces for agents. The same day: a program
that reads `status` (a hook script, a tool) gets it as JSON on request, with the same fields as the
AXI envelope (`--format json`).

## Scope

### §S1 — the plans route filters by status

`GET /api/v2/projects/<key>/plans` accepts an optional `status` query parameter whose value is one
of the plan statuses `open`, `closed`, `aborted`. It composes with the existing `cr` and `track`
filters. The filter is applied to the stored rows **before** they are turned into plans, so a
filtered-out plan is never built and its `commitBoundary` is never derived. Any other `status`
value is refused: `400`, `ok:false`, and a `help[]` naming the three accepted values. Without the
parameter the route returns what it returns today, so the board and every other caller are
unchanged.

### §S2 — the plans route publishes two project facts

Every `GET …/plans` response carries two top-level fields beside `plans`, computed over **all** of
the project's plans whatever `status`, `cr` or `track` filter the request carried:

- **`lastClosedCr`** — the `cr` of the plan with the latest `closedAt`, or `null` when no plan has
  closed. Aborted plans have no `closedAt` and never count.
- **`filed`** — the number of plans the project has ever filed, whatever their status.

This moves the `lastClosedCr` computation (CR-CRU-094) from the client to the server: the client
function `last_closed_cr` is deleted, and the one place the value is computed is the server.

### §S3 — `status` reads the open plans

`cmd_status` reads `GET …/plans?status=open`. Its `plans[]` rows are the rows that read returns, in
the order the server publishes them. `count` is the number of rows, still unaffected by
`--fields`. `lastClosedCr` and `filed` are passed through from the response unchanged. The client
does not filter or recompute anything itself.

### §S4 — three reachable states, told apart by `filed`

| State | `plans` | `count` | `filed` | `lastClosedCr` | `help[]` |
|---|---|---|---|---|---|
| **Work in flight** | the open plans | > 0 | > 0 | as published | `cycle-activate <id>` (as today) |
| **None open** | `[]` | 0 | > 0 | as published (`null` on an aborted-only board) | `next`, then `plan-file --cr <cr> --cycle <label>` |
| **Never filed** | `[]` | 0 | 0 | `null` | `plan-file --cr <cr> --cycle <label>` |

All three are `ok:true`, `warnings:[]`, exit 0. `filed` is the signal that separates "never filed"
from "none open", including the aborted-only board where `lastClosedCr` is `null` (Model B's
request, #1391).

### §S5 — the unavailable degrade is unchanged, plus `filed`

When the plans read fails, the envelope is today's `status-unavailable` degrade, with `filed: null`
added: the board could not be read, so the number is unknown, not zero.

### §S6 — the contract says what the verb does

`clients/STATUS-CONTRACT.md` states §S1–§S8. It is a **breaking** change to the rows a consumer
gets, so the version goes **2.0.0 → 3.0.0**, with a line naming what changed. It names `queue` (with
`cr-plan --full`) as the read for every CR and plan; `status` gains no flag for it (settled by
Model B's answer, #1391).

### §S7 — all five clients

Every client reaches `status`, and the no-argument dashboard, through the one shared `cmd_status`.

### §S8 — a program can ask for JSON

`status` and its alias `plans` accept `--format {toon,json}`, default `toon`, in all five clients.
`toon` is today's output. `json` writes the same envelope as ONE JSON object on stdout: every key
the AXI envelope's `axi` object carries (`verb`, `ok`, `tier`, `plans`, `lastClosedCr`, `count`,
`filed`, `help`, `context`, `warnings`) with the same values, unwrapped (no `axi` key). This holds
on every exit path: the three §S4 states and the §S5 degrade, whose signal a program reads as the
`warnings[].code` value `status-unavailable`. Exit codes and the stderr line are unchanged. The
no-argument dashboard does not take the flag.

### §S9 — the release ceremony reads its landings through `landings`

`scripts/release.sh` attributes each CR to a release from the merge commit its closed plan
recorded, and reports a closed plan that recorded none. It read both from `plans --fields
mergeCommit`, which §S3 narrows to the open plans. Its input is the **closed plans**, which
exist whether or not the queue holds their CR, so `queue` cannot stand in (user ruling
2026-09-26, option C). A new read-only verb, `landings`, in all five clients through one shared
implementation, issues exactly one read, `GET …/plans?status=closed` (§S1), and returns one row
per closed plan, in the server's order: `cr`, and `mergeCommit` (the commit the plan recorded,
or `null` when it recorded none). It takes `--format {toon,json}` exactly as §S8 defines it for
`status`. A failed read is `ok:true`, no rows, a `landings-unavailable` warning, exit 0, the
same shape as `status`'s degrade. The ceremony reads `landings --format json` and calls neither
`plans` nor `status`; `queue` is unchanged.

## Acceptance criteria

- **AC1 (§S1)** — On a board with open, closed and aborted plans, `GET …/plans?status=open`
  returns exactly the open plans, `?status=closed` exactly the closed ones and `?status=aborted`
  exactly the aborted ones; `?status=open&cr=<cr>` returns only that CR's open plan. The response
  to `?status=open` carries no plan with a `commitBoundary`.
- **AC2 (§S1)** — `GET …/plans?status=<anything else>` (including the empty string) answers `400`,
  `ok:false`, with a `help[]` naming `open`, `closed` and `aborted`. `GET …/plans` with no `status`
  parameter returns the same `plans` array it returns today.
- **AC3 (§S2)** — On the AC1 board, every `GET …/plans` response (unfiltered, `?status=open`,
  `?cr=<cr>`) carries `filed` equal to the project's total plan count and `lastClosedCr` equal to
  the `cr` with the latest `closedAt` (two plans closed at the same `closedAt`: the higher
  `planId`). On a board of only aborted plans, `lastClosedCr` is `null`
  and `filed` equals the number of aborted plans. On a project with no plans, `filed` is `0` and
  `lastClosedCr` is `null`.
- **AC4 (§S3)** — `cmd_status` issues exactly one read, `GET …/plans?status=open`. Its rows are
  that response's plans in order, `count` equals the number of rows, and `lastClosedCr` and
  `filed` equal the response's values.
- **AC5 (§S4)** — Three boards produce the three states of the §S4 table, field for field,
  including `help[]`: work in flight; none open (one board with a closed plan, one with only
  aborted plans); never filed.
- **AC6 (§S5)** — On a failed plans read the envelope is today's `status-unavailable` degrade
  byte for byte, except for one added field, `filed: null`.
- **AC7 (§S2)** — `last_closed_cr` is defined nowhere in `clients/` or `crucible_axi/`. CR-094's
  inventory test is amended to pin that the value is published by the server, not computed by any
  client.
- **AC8 (§S6)** — `STATUS-CONTRACT.md` is version 3.0.0. Its field table, terminal states, degrade
  shape and row schema describe §S1–§S5, including `filed`. It names `queue` as the read for every
  CR and plan. It documents `--format json` (§S8) with an example object. No sentence in it
  describes the old behaviour as current.
- **AC9 (§S7)** — `status` is called through the shared `cmd_status` from `status`, its alias
  `plans` and the no-argument dashboard in EACH of `bun-crucible.py`, `python-crucible.py`,
  `rust-crucible.py`, `mvn-crucible.py` and `arduino-crucible.py`, and the AC5 "none open" and
  "never filed" states are asserted for each of the five.
- **AC10 (wiring)** — End to end against a real, ephemeral board holding open, closed and aborted
  plans: the `status` verb's envelope has the open plans as rows, and `filed` and `lastClosedCr`
  equal the server's values. No stubbed transport.
- **AC11 (§S8)** — In EACH of the five clients, `status --format json` and `plans --format json`
  write exactly one JSON object to stdout whose keys and values equal the `axi` object of the
  same invocation with `--format toon`, on all four exit paths (work in flight, none open, never
  filed, unavailable). `--format toon` and no flag produce today's TOON output. A value other
  than `toon` or `json` is refused by argument parsing. The `status`/`plans` help text and each
  client's `cmd_status` docstring describe the open plans, `filed` and `--format`; none still
  describes the unfiltered plan list.
- **AC12 (§S8)** — AC10's end-to-end run is repeated with `--format json`, and the parsed object
  carries the open plans as `plans`, and the server's `filed` and `lastClosedCr`.
- **AC13 (§S9)** — In EACH of the five clients, `landings` issues exactly one read,
  `GET …/plans?status=closed`. On a board holding a plan closed with a merge commit, a plan
  closed without one, an aborted plan and an open plan, its rows are exactly the two closed
  plans, in the server's order, each `{cr, mergeCommit}` with `null` for the one that recorded
  none. `--format json` writes the same object as one JSON object (§S8's rule). A failed read
  is `ok:true`, `landings:[]`, a `landings-unavailable` warning, exit 0.
- **AC14 (§S9)** — `scripts/release.sh` calls neither `plans` nor `status`, takes each
  closed plan's landing commit (and each closed plan that recorded none) from
  `landings --format json`, and `tests/release-provenance.test.ts` passes in full.
- **AC15 (§S9)** — End to end against a real, ephemeral board: the `landings` verb, run as a
  real client subprocess, returns exactly the closed plans the server's own
  `GET …/plans?status=closed` returns, with their merge commits. No stubbed transport.

## Non-goals

- **Changing `queue`, `next` or the board.** They read other routes or the unfiltered list.
- **Changing what a plan's status means.** `open`, `closed` and `aborted` are unchanged.
- **Serving a newer client from an older server.** Server and clients install together as one
  version-locked operation, so no client-side fallback is built for an older server.

## Model B

Model B runs released clients only (#1383), so this reaches them with the release that carries it,
and they are told in that release's notes (user ruling 2026-09-24). **Before implementation** they
were asked (#1390) whether the change is acceptable. **Their answer (#1391, 2026-09-24):**

1. **Acceptable.** Open plans only is what their ambient session-start hook wants.
2. **Nothing of theirs reads closed or aborted rows.** The one consumer is
   `hooks-src/scripts/ambient-board-status` (CR-MDB-019). It drops `closed` rows and treats every
   other status as open, `aborted` included, so this change also fixes that for them.
3. **No `--all` wanted.** They read `queue` (plus `cr-plan --full`) for every plan (§S6).
4. **One request:** keep "no plan filed" and "nothing open" distinguishable, the aborted-only board
   included. `filed` does this (§S4). They re-pin the hook to 3.0.0 when the release ships, and
   can switch it to `status --format json` (§S8) in the same step.
