# CR-CRU-147 — a voided CR is not queued work, and its row says so

**Type** fix · **Wave** 7 (0.3.0) · **Depends on** CR-CRU-091, CR-CRU-078 · **Status** PENDING

## Problem

**Reported by Model B (Sandesh #1384, 2026-09-23), independently reproduced here.** `cr-void` and
`cr-supersede` return `ok=True` and write `lifecycle.state`, yet the CR goes on reading as live work:

- `queue` renders it `CR-MDB-012,"2",PENDING,null`. Model B's CR-MDB-007 has read PENDING that way
  since 2026-07-20.
- `next` surfaced an already-ruled CR to them for exactly this reason.
- No client verb can correct it, so their workaround is to park the CR in a made-up wave 99 with its
  `dependsOn` stripped from 25 to 0. It still reads PENDING.

**Reproduced on this board:** CR-CRU-082 carries `lifecycle.state: VOID` with a reason recorded
three times over, while `queue` renders `CR-CRU-082,"5",PENDING,null`. This project's own
orchestrator read that row as a stale PENDING entry and reported it to the user as one. The failure
therefore reaches humans, not only `next`.

**This is a consumer defect, not a data defect.** CR-CRU-091 §S2 made `lifecycle` a **second
axis**, deliberately never folded into `status`. The PRD locks `status` as derived (PENDING = no
plan, IN_PROGRESS = open plan, COMPLETED = closed + merge, `PRD-crucible-v2.md:350-352`): `status`
answers *what happened to the work*, `lifecycle` answers *whether the work is still wanted*. The
data is right. What is missing is that the surfaces that decide what is live work never read the
second axis.

**The representation is already ruled.** CR-CRU-078 AC27 (COMPLETED) requires both lifecycle states
to show distinguishably on the CR's row and flowchart node, with a `SUPERSEDED` row naming its
successor and a `VOID` row legible as abandoned, and neither mistakable for `PENDING`. This CR
extends that ruling to the consumers AC27 did not reach. It does not reopen it.

## Scope

### §S1 — a dead CR is not live work

A CR whose `lifecycle.state` is `VOID` or `SUPERSEDED` is excluded from every surface that answers
*what is the work*:

- **`next`** never offers it, and never counts it as a dependency the offered CR still waits on.
- **The zone-2 Wave Card** does not list it (user ruling 2026-09-23). A wave card shows the wave's
  live work, and a dead CR is not part of it.
- Wave-membership counts that describe live work do not count it.

**The record is kept.** A void is not a deletion. The row, its derived `status`, its `lifecycle`
object and its reason all survive and remain readable. Exclusion is a reading of the second axis,
never a write to the first.

### §S2 — the table row shows it as dead (user rulings 2026-09-23 and 2026-09-24; storyboard F17, approved)

In the roadmap table the row stays visible and struck through, so the history still reads. This
composes with CR-CRU-078 AC27 rather than replacing it: a `SUPERSEDED` row still names its successor
and a `VOID` row still reads as abandoned. The strikethrough adds that neither is live.

**Measured on the live board 2026-09-24 (CR-CRU-141, just voided):** the row already renders a
strikethrough, but its **title is missing**, its STATUS cell reads **`PENDING`**, and the lifecycle
reason is written into the row as text. That text pushes every cell out of its column and runs off
the right edge, giving the whole table a horizontal scrollbar. F17 draws the defect and the fix:

- **The row keeps the table's grid.** A dead row has the same cells as every other row: id, title,
  points, depends-on and status. The **id, title and points are struck through** and dimmed, and the
  depends-on chips fade. Nothing is added to the row.
- **The STATUS cell names the state:** `VOID`, or `SUPERSEDED → <successor>`, never `PENDING`. This
  is **display only**. The queue's `status` field stays derived (PRD `:350-352`), and `lifecycle`
  stays the second axis (CR-091 §S2). The cell shows the lifecycle state when one exists, in place
  of the derived status.
- **The reason is a tooltip** on the status badge (`ⓘ`): state · date · who, then the full reason,
  wrapped. On a phone a tap opens the same bubble. The reason never renders inline in the row.

### §S3 — the `queue` row carries what makes a dead row self-evident

Each `queue` row gains **`title`** and **`lifecycle.state`**; it is `cr, wave, status, planId`
today. With both fields, a dead row is legible from the verb's own output, and board-vs-spec title
drift becomes checkable read-only. Today the only way to audit a title is to re-post the row and read
the echo, which is how Model B found four drifted titles.

## Acceptance criteria

**§S1**
- [ ] `next` never returns a `VOID` or `SUPERSEDED` CR, asserted against a CR that would otherwise be
      the next in sequence.
- [ ] A live CR that `dependsOn` a dead one is not held waiting on it by `next`. The CR states
      whether a dead dependency is satisfied or ignored and asserts it, rather than leaving it to
      the implementer.
- [ ] The zone-2 Wave Card does not render a dead CR, and its live-work counts exclude it.
- [ ] The record survives: after `cr-void`, the queue read still returns the row with its derived
      `status` and its `lifecycle` object intact.

**§S2**
- [ ] A dead CR's roadmap table row has the same cells, in the same columns, as a live row: id,
      **title**, points, depends-on, status. The id, title and points are struck through. No cell of
      the row, and no row of the table, overflows its column or the table's width, asserted by
      measured geometry on a row whose reason is longer than the table is wide.
- [ ] The STATUS cell reads `VOID` for a voided CR and `SUPERSEDED → <successor>` for a superseded
      one (078 AC27), never `PENDING`. The queue read's `status` for the same CR is still the derived
      value: the change is to the cell, not the data.
- [ ] The lifecycle reason is not rendered in the row. It is the status badge's tooltip (state ·
      date · who · reason), reachable by hover on desktop and by tap on the phone band.
- [ ] A row with no `lifecycle` key renders exactly as today, with no strikethrough and no default.

**§S3**
- [ ] Every `queue` row carries `title`, and carries `lifecycle.state` when present. Absent means
      omitted, never defaulted.
- [ ] Rows without a lifecycle render as they do today; no existing consumer of the `queue` envelope
      breaks.

## Risk

- **Folding `lifecycle` into `status`.** That is the tempting fix, and it is forbidden: the PRD
  locks `status` as derived, and CR-CRU-091 §S2 kept the axes separate on purpose. A build that makes
  the queue's `status` **field** read `VOID` fails this CR as surely as one that ignores the
  lifecycle. The table's STATUS **cell** showing `VOID` (§S2, F17) is not that: it displays the
  second axis where one exists, and the data underneath is unchanged.
- **Model B pins released clients** (#1383), so §S3 reaches them at release time, not at merge.

## Non-goals

- Changing how `status` is derived.
- A client verb that writes `status` directly. Model B asked for none, and the derivation forbids it.
- Deleting voided CRs from the store.

## Coupling (recorded 2026-09-24, at CR-CRU-022's planning game)

CR-CRU-098 moves the `next` resolver from the client to the server; CR-CRU-147 changes what `next`
skips (VOID and SUPERSEDED CRs). Both touch the same resolver. **Whichever lands first owns it, and
the other adapts** — if CR-CRU-098 lands first, this CR's skip is implemented in the server resolver, not the client. Never two resolvers.

**Corrected at CR-CRU-098's gap analysis (2026-09-24) — for this CR's own gap analysis to take up:**

- **`next` already skips dead CRs.** `_is_actionable` (`"lifecycle" not in entry`), `_dead_entries`
  and the `dead-dependency` trigger have been in the resolver since `da67a55` (CR-092, 2026-08-28),
  shipped in 0.2.0–0.2.2. Measured live on this board: `next --wave 5` names CR-CRU-082 (VOID) as a
  corpse and does not offer it. §S1's first `next` AC is therefore already met; Model B's report
  that `next` surfaced a ruled CR is not reproduced here, and which client version they ran is
  unmeasured.
- **§S1's second AC contradicts shipped, ruled behaviour.** Today a live CR depending on a dead one
  is HELD with trigger `dead-dependency` and told to re-point its `dependsOn` (CR-092). This CR's
  AC says it is *not* held. Which is right is a decision for this CR's gap analysis, not an
  implementation detail.
- **CR-CRU-098 lands first** (wave order) and moves the resolver to the server unchanged; any change
  to `next` here is made in that server function.
- **Two dead-CR predicates now live on the server (recorded at CR-CRU-098's merge, `42419fe`).**
  `isDeadCr` (`src/types.ts`) reads `lifecycle.state ∈ {VOID, SUPERSEDED}`; `src/next.ts`'s
  `isActionable` reads the **presence** of a `lifecycle` key, ported verbatim from the client so
  CR-098 changed no semantics. They agree on every `listQueue` row today, and differ for
  `lifecycle: null` or a lifecycle whose state is neither. This CR owns dead-CR semantics, so
  unifying them on one predicate is in its scope.
