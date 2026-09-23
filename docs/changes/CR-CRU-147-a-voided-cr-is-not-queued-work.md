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

### §S2 — the table row shows it as dead (user ruling 2026-09-23)

In the roadmap table the row stays visible, rendered with a **strikethrough**, so the history still
reads. This composes with CR-CRU-078 AC27 rather than replacing it: a `SUPERSEDED` row still names
its successor and a `VOID` row still reads as abandoned. The strikethrough adds that neither is live.

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
- [ ] A dead CR's roadmap table row renders with a strikethrough, and 078 AC27 still holds on the same
      row: a `SUPERSEDED` row names its successor, a `VOID` row reads as abandoned, and neither reads
      as `PENDING`.
- [ ] A row with no `lifecycle` key renders exactly as today, with no strikethrough and no default.

**§S3**
- [ ] Every `queue` row carries `title`, and carries `lifecycle.state` when present. Absent means
      omitted, never defaulted.
- [ ] Rows without a lifecycle render as they do today; no existing consumer of the `queue` envelope
      breaks.

## Risk

- **Folding `lifecycle` into `status`.** That is the tempting fix, and it is forbidden: the PRD
  locks `status` as derived, and CR-CRU-091 §S2 kept the axes separate on purpose. A build that makes
  `status` read `VOID` fails this CR as surely as one that ignores the lifecycle.
- **Model B pins released clients** (#1383), so §S3 reaches them at release time, not at merge.

## Non-goals

- Changing how `status` is derived.
- A client verb that writes `status` directly. Model B asked for none, and the derivation forbids it.
- Deleting voided CRs from the store.
