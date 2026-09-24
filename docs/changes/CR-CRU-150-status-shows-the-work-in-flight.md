# CR-CRU-150 — `status` shows the work in flight, not the project's history

**Type** feature · **Points** 5 · **Wave** 7 (0.3.0), before CR-CRU-149 (user ruling 2026-09-24) · **Depends on**
CR-CRU-030, CR-CRU-035, CR-CRU-094 · **Status** PENDING — filed 2026-09-24

## Problem

**Reported by Model B (Sandesh #1389, 2026-09-24), reproduced here.** `status` returns every plan
the project has ever filed. On this board today that is `plans[138]`: 130 `closed`, 8 `aborted`,
**0 `open`**, `count: 138`. Model B measured `plans[31]`, mostly closed, against production.

**This is not a defect in the verb.** CR-030 §S6, the verb's origin, asks for "the queue table
(`cr`, `wave`, `status`, active cycle, `mergeCommit`) plus `lastRunCr`", which is every plan, and
`cmd_status` has passed `GET …/plans` through unfiltered since then. `STATUS-CONTRACT.md:40` says
"one uniform row per **open** plan". That sentence was written by CR-035, whose spec described the
verb as "already degrades on no open plan (… empty envelope)", which it never did. The contract's
own row schema (`status`: "`open` / closed", a `mergeCommit` column) still describes every plan.

**It is a design problem.** `status` is the verb CR-035 made safe for **session-start hooks**, so
every session start pays for, and prints, the whole history:

- **The output is unbounded.** It grows by one row per CR, forever, into a surface whose job is
  "what is in flight".
- **The read is the expensive one.** `GET …/plans` returns closed plans "with the derived
  `commitBoundary`" (`src/v2.ts:1899`), the per-plan derivation CR-CRU-126 measured as the plan
  read's cost.
- **Consumers filter it themselves.** Model B's CR-MDB-019 hook drops `status == closed` on its
  side.

**User ruling 2026-09-24:** scope `status` to open plans (option 3 of three offered: fix the
contract sentence, reply only, or change the verb).

## Scope

### §S1 — `plans[]` is the open plans

`status` rows are the plans whose status is `open`. Closed and aborted plans are not rows.
`count` is the number of rows it reports: the open plans, still unaffected by `--fields`.

### §S2 — `lastClosedCr` is kept

The last CR to close stays on the envelope (CR-CRU-094): an orchestrator starting a session still
learns what just landed. It is no longer derivable from the rows, so it must come from somewhere
that is not the full plan list. **Where** is this CR's first design question (below).

### §S3 — the empty state says "nothing in flight"

A reachable board with no open plan is `ok:true`, `plans:[]`, `count:0`, `warnings:[]`, a `help[]`
naming the next move, and `lastClosedCr` still set when any plan has ever closed. The contract's
"no plan filed" state becomes "no plan open". The `status-unavailable` degrade is unchanged.

### §S3a — "never filed" and "none open" stay distinguishable (Model B's request, #1391)

Today a consumer tells "no plan filed" (`count:0`) from "nothing open" (rows, all closed). Under
§S1 both arrive as `plans:[]`, `count:0`. `lastClosedCr` separates them only when some plan has
closed: a board holding only **aborted** plans has `lastClosedCr: null` and would read as "never
filed". The envelope therefore carries **one explicit signal** that differs between the two
states, named in the contract (design question 3).

### §S4 — the contract says what the verb does

`STATUS-CONTRACT.md` states §S1–§S3. It is a **breaking** change to the rows a consumer gets, so
the version goes **2.0.0 → 3.0.0**, with a line naming what changed.

### §S5 — all five clients

Every client reaches `status`, and the no-argument dashboard, through the one shared `cmd_status`.

## Design questions for the gap analysis (to the user, not the implementer)

1. **Filter on the server or the client?** A server filter (e.g. `GET …/plans?status=open`)
   removes the closed plans' `commitBoundary` derivation from every session start, which is the
   cost that matters. A client filter changes only what is printed. If it is the server, then
   `lastClosedCr` (§S2) needs its own source: the server publishing it, or a cheap read of the
   latest `cr-merged` milestone.
2. ~~**Is there still a way to see every plan?**~~ **Settled by Model B's answer (#1391):** no
   `--all`. `queue` (with `cr-plan --full`) is the read for every CR and plan, and the contract names
   it as such.
3. **Which signal separates "never filed" from "none open"** (§S3a): a `help[]` line or warning
   code that differs, or a total-plans figure beside `count`. Model B accepts either; the contract
   names the one chosen.

## Acceptance criteria

- **AC1** — On a board with open, closed and aborted plans, `status` rows are exactly the open
  plans, in the order the server publishes them, and `count` equals the number of rows.
- **AC2** — `lastClosedCr` is the `cr` of the most recently closed plan, exactly as today, on every
  terminal state including "no plan open".
- **AC3** — A board whose plans are all closed or aborted answers `ok:true`, `plans:[]`, `count:0`,
  `warnings:[]`, a `help[]` naming the next move, and a non-null `lastClosedCr`.
- **AC4** — The `status-unavailable` degrade is byte-identical to today's.
- **AC5** — `STATUS-CONTRACT.md` is version 3.0.0, and its field table, terminal states and row
  schema describe §S1–§S3. No sentence in it describes the old behaviour as current.
- **AC6** — All five clients and the no-argument dashboard go through the one `cmd_status`, and the
  AC1–AC3 behaviour is asserted for each.
- **AC7** — Whatever the gap analysis rules on design question 1 is asserted by its own AC,
  added to this spec before the branch cut.
- **AC8** — §S3a: three boards (no plan ever filed; only aborted plans; only closed plans) each
  produce `plans:[]` and `count:0`, and the named signal tells the first apart from the other two
  on every one of them, including the aborted-only board where `lastClosedCr` is null.
- **AC9** — The contract names `queue` as the read for every CR and plan, and `status` gains no
  flag for it.

## Non-goals

- **Changing `queue`, `next` or the board.** They read other routes.
- **Changing what a plan's status means.** `open`, `closed` and `aborted` are unchanged.

## Model B

Model B runs released clients only (#1383), so this reaches them with the release that carries it,
and they are told in that release's notes (user ruling 2026-09-24). **Before implementation** they
were asked (#1390) whether the change is acceptable. **Their answer (#1391, 2026-09-24):**

1. **Acceptable.** Open plans only is what their ambient session-start hook wants.
2. **Nothing of theirs reads closed or aborted rows.** The one consumer is
   `hooks-src/scripts/ambient-board-status` (CR-MDB-019). It drops `closed` rows and treats every
   other status as open, `aborted` included, so this change also fixes that for them.
3. **No `--all` wanted.** They read `queue` (plus `cr-plan --full`) for every plan (AC9).
4. **One request:** keep "no plan filed" and "nothing open" distinguishable, the aborted-only board
   included (§S3a, AC8). They re-pin the hook to 3.0.0 when the release ships.
