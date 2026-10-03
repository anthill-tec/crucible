# CR-CRU-165 — a plan grows only by FIX cycles, and a skipped cycle is a recorded failure

**Type** feature · **Points** 13 (planning game 2026-10-03: 8; re-set at gap analysis 2026-10-03) · **Wave** 7 (0.3.0) · **Depends on** — · **Status** PENDING — filed 2026-10-03

## Problem

**Request from Sandesh (#1418 item 5, 2026-10-03).** The clients have no verb to retire a dead
cycle. Sandesh had to call `PATCH /api/v2/projects/<key>/plans/<plan>/cycles/<id>` with
`{"status":"skipped"}` by hand, and it asked for a `cycle-skip` verb.

**The owner's rulings (2026-10-03):**
- A filed cycle plan is fixed. The only change allowed to it is **appending a FIX cycle** after a
  VERIFY whose findings need fixes, before the pre-merge gate and close-out.
- A spec that changes partway through a CR's implementation shows that the spec's design or its gap
  analysis fell short. Skipping a cycle is therefore never routine. It is used sparingly, only when
  such a change has made a planned cycle obsolete, always behind guards, and always on the record
  as a process failure.

**Measured 2026-10-03:** the cycle PATCH route accepts `status: skipped` from `pending` **and from
`active`** (`CYCLE_TRANSITIONS` in the store), and a cycle record carries no reason field (`id,
kind, label, status, doneAt`). Of this project's 552 cycles, 23 are skipped and none records why:
**20 were written by `abortPlan`** (an aborted plan's pending cycles; CR-035, 037, 077, 095, 122,
123, 145) and **3 by a hand PATCH** in plans that later closed (CR-033, 117, 131).

## Gap analysis (2026-10-03)

**Baseline, measured 2026-10-03 16:09–16:11 on develop `0dcd70f`:** the cycle guard, label edit,
insert-before, abort, plan list (scoped and global), ingest cycle validation, timer/epoch and
analytics UI bun suites, **85/0**; the cycle-add, cycle-add targeting, plan-file kinds and envelope
census python suites, **130/0** (both filed project-scoped under `vidushi`).

- **G1 — two existing ways to change a filed plan, besides appending.** CR-CRU-024 gave the cycle
  routes `before: <cycleId>` on `POST …/cycles` (insert-before, §S3.1) and `{label}` on
  `PATCH …/cycles/<id>` (rename, §S3.2). Neither has a client verb or a UI; both are reachable only
  over HTTP (tests `cycle-insert-before`, `cycle-edit-label`). Under the ruling both are plan
  changes. **R1 (user, 2026-10-03): retire both.**
- **G2 — an active cycle can be skipped today** (`active → skipped` is legal). §S2 allows only a
  pending cycle; the transition table changes so an active cycle ends `done` or `failed`.
  **R2 (user, 2026-10-03): pending only.**
- **G3 — abort already skips, and is a re-plan.** `abortPlan` marks every pending cycle skipped and
  the plan `aborted`; the CR is then re-filed (CR-145: plan aborted, cycles 511–515 skipped, re-filed
  as 516–519). That is the existing mechanism for "the spec changed and the plan no longer fits".
  Its skips must stay distinguishable from a `cycle-skip` (they carry no reason fields), and the
  defect count in §S3 must say which it counts. **R3 (user, 2026-10-03): an abort records a reason,
  cause and spec reference too, and counts as a defect signal.**
- **G4 — N1's cause.** With `--plan`, `cmd_cycle_add` takes the CR from `args.cr`
  (`resolve_named_plan_or_emit`), which is unset, hence `cr=None`. The plan record already carries
  its CR; the envelope reads it from there.
- **G5 — N2's cause.** `handlePlansGlobalList` takes no filter: it lists every project's plans and
  ignores the query string. It either applies `cr`/`status` with the project route's validation or
  refuses them; the project route stays as it is.
- **G6 — storage.** The reason, cause and spec reference are three new cycle columns: a declared
  store migration (CR-CRU-071) to schema v14, carried by the plan read and the Workflow tab.
- **G7 — the board already draws a skip** (`⊘`, a terminal status in the Workflow tab); §S3 adds
  the reason on the row and the plan's skip count. Analytics has no per-release count of anything
  on cycles today; the skip count by cause is a new analytics read.
- **Cost.** 13 points, not 8: R3 adds a second recorded path (abort, with its fields on the plan
  and its verb in five clients) and its count in §S3; R1's retirement is two route branches and
  their two test files; R2 is one transition.

## Scope

### §S1 — the plan grows only by FIX cycles

`cycle-add` (verb and route) appends only a cycle of kind `fix`, and only to an open plan whose
VERIFY cycle is done. Any other kind is refused with the rule and the `cycle-add --kind fix` usage.

The two other ways CR-CRU-024 left to change a filed plan are retired (R1): `before:` on
`POST …/cycles` (insert-before, §S3.1) and `{label}` on `PATCH …/cycles/<id>` (rename, §S3.2).
Each is refused with a 400 naming the rule; their store paths and tests go.

### §S2 — `cycle-skip`, guarded and recorded

`cycle-skip <id> --reason <text> --cause spec-design|gap-analysis --spec-ref <commit or §>` on the
orchestrator role only. It is refused unless:
- the cycle is **pending**: never active, done or failed, and no run is filed against it (R2:
  `active → skipped` leaves the transition table; an active cycle ends `done` or `failed`);
- the plan keeps at least one cycle that is not skipped;
- `--reason`, `--cause` and `--spec-ref` are all given.

The cycle is never deleted. It stays on the board, marked skipped, showing its reason, cause and
spec reference. The verb's envelope carries a warning that a skip records a failure of the spec or
of its gap analysis. Its `help[]` says the verb is exceptional. The same guards apply to the PATCH
route, so the route cannot be used to get round the verb.

### §S2b — an abort is a recorded failure too (R3)

`abort` (verb and route) requires `--reason`, `--cause spec-design|gap-analysis` and `--spec-ref`,
stores them on the plan, and carries the same process-failure warning. The pending cycles it skips
show the abort's reason, so every skipped cycle on the board says why.

### §S3 — skips and aborts are visible as a defect signal

A plan with skipped cycles shows the count on the Workflow tab, and an aborted plan shows its
reason. Analytics counts, per release, cycle skips and plan aborts, each broken down by cause, so
the retrospective can review them. The 23 historical skips and the aborted plans before this CR
carry no reason and are shown as unrecorded, never back-filled.

### §S4 — notes found on 2026-10-03 (AXI standard)

- **N1:** `cycle-add --plan 166 --kind fix` printed `cr=None`, although cycle 552 belongs to plan 166
  (CR-CRU-159). The envelope carries the plan's resolved CR, plan id, kind and label, as
  `plan-file` does.
- **N2:** the unscoped `GET /api/v2/plans` silently ignores `cr=` and `status=` and returns every
  plan of every project (149). The project route `GET /api/v2/projects/<key>/plans` honours both
  and refuses a bad status with a 400. The unscoped route either honours the filters or refuses
  them with a 400 naming the project route. It never returns an unfiltered list for a filtered
  query.

## Acceptance criteria

- [ ] **AC1** — `cycle-add` with a kind other than `fix`, or before the plan's VERIFY is done, is
      refused with the rule; a `fix` cycle after a done VERIFY is appended.
- [ ] **AC2** — `cycle-skip` on a pending cycle with reason, cause and spec reference marks it
      skipped and stores all three; the board shows them.
- [ ] **AC3** — `cycle-skip` is refused for an active, done or failed cycle, a cycle with a run
      filed, the plan's last unskipped cycle, a missing reason, cause or spec reference, and a
      non-orchestrator caller. Each refusal names its rule.
- [ ] **AC4** — the PATCH route enforces the same guards.
- [ ] **AC5** — the envelope carries the process-failure warning, and `help[]` marks the verb as
      exceptional, in all five clients.
- [ ] **AC6** — the Workflow tab shows a plan's skip count and each skipped cycle's reason, and an
      aborted plan's reason.
- [ ] **AC7** — `cycle-add`'s envelope names the plan's CR (N1).
- [ ] **AC8** — the unscoped plans route honours or refuses `cr=` and `status=` (N2).
- [ ] **AC9** — `before:` on `POST …/cycles` and `{label}` on `PATCH …/cycles/<id>` are refused with
      the rule (R1).
- [ ] **AC10** — `PATCH` an active cycle to `skipped` is refused; an active cycle ends `done` or
      `failed` (R2).
- [ ] **AC11** — `abort` without reason, cause or spec reference is refused; with them, the plan
      stores all three, its skipped cycles show the reason, and the envelope carries the warning,
      in all five clients (R3).
- [ ] **AC12** — analytics counts skips and aborts per release by cause; pre-existing ones are
      counted as unrecorded.
- [ ] **AC13** — the crucible skill's verb list names `cycle-skip` and the new `abort` flags, and
      states that a plan grows only by FIX cycles.

## Cycles

C1 server — R1 retirement, R2 transition, `cycle-skip` guards and storage (migration to v14), abort
fields, N2 (AC1 server half, AC3, AC4, AC8–AC10, AC11 server half): RED + GREEN.
C2 clients — `cycle-skip` and the `abort` flags in all five, `cycle-add` fix-only and N1, the skill
(AC1, AC2, AC5, AC7, AC11, AC13): RED + GREEN.
C3 board — the Workflow tab and the analytics count (AC6, AC12): RED + GREEN.
C4 VERIFY.
