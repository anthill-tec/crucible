# CR-CRU-165 — a plan grows only by FIX cycles, and a skipped cycle is a recorded failure

**Type** feature · **Points** 8 (planning game 2026-10-03) · **Wave** 7 (0.3.0) · **Depends on** — · **Status** PENDING — filed 2026-10-03

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

**Measured 2026-10-03:** the cycle PATCH route accepts `status: skipped` from any of `pending |
active | done | skipped | failed`, and a cycle record carries no reason field (`id, kind, label,
status, doneAt`). Of this project's 552 cycles, 23 are skipped, and none records why.

## Scope

### §S1 — the plan grows only by FIX cycles

`cycle-add` (verb and route) appends only a cycle of kind `fix`, and only to an open plan whose
VERIFY cycle is done. Any other kind, or an earlier position, is refused with the rule and the
`cycle-add --kind fix` usage.

### §S2 — `cycle-skip`, guarded and recorded

`cycle-skip <id> --reason <text> --cause spec-design|gap-analysis --spec-ref <commit or §>` on the
orchestrator role only. It is refused unless:
- the cycle is **pending**: never active, done or failed, and no run is filed against it;
- the plan keeps at least one cycle that is not skipped;
- `--reason`, `--cause` and `--spec-ref` are all given.

The cycle is never deleted. It stays on the board, marked skipped, showing its reason, cause and
spec reference. The verb's envelope carries a warning that a skip records a failure of the spec or
of its gap analysis. Its `help[]` says the verb is exceptional. The same guards apply to the PATCH
route, so the route cannot be used to get round the verb.

### §S3 — skips are visible as a defect signal

A plan that has skipped cycles shows the count on the Workflow tab. Analytics counts skips per
release, broken down by cause, so the retrospective can review them.

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
- [ ] **AC6** — the Workflow tab shows a plan's skip count; analytics counts skips per release by
      cause.
- [ ] **AC7** — `cycle-add`'s envelope names the plan's CR (N1).
- [ ] **AC8** — the unscoped plans route honours or refuses `cr=` and `status=` (N2).
