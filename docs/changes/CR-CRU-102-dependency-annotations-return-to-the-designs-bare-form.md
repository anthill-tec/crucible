# CR-CRU-102 — dependency annotations return to the design's bare form

- **Type**: patch
- **Wave**: 5 (0.2.0)
- **Depends on**: none — the annotation is a rendering of data already published
- **Status**: PENDING (0.2.0) — filed 2026-09-03
- **Found by**: the user, reviewing the approved design against the shipped board after CR-CRU-097

## Problem

The approved design (`.lavish/crucible-workflow-flowchart.html`, approved 2026-08-28) writes a
dependency annotation as a **bare number**. Zone 2, lines 195-198:

```
CR-CRU-096   deps 078
CR-CRU-079   deps 078
CR-CRU-093   deps 006
```

and zone 3's row grammar, line 235, states it in words: *"CR id + brief title + **bare
depends-on** + status + cycle overlay"*.

The shipped board renders the **full published id** in both zones, verified live 2026-09-03:

| surface | design | shipped |
| --- | --- | --- |
| zone 2 annotation | `deps 078` | `deps CR-CRU-078` |
| zone 2, four deps | `deps 014, 091, 092, 095` | `deps CR-CRU-014, CR-CRU-091, CR-CRU-092, CR-CRU-095` |
| zone 3 depends-on cell | `001` | `CR-CRU-001` |

### The divergence was RULED, not accidental — and this CR must beat the ruling, not ignore it

**Corrected 2026-09-04 by gap analysis.** This CR previously said CR-CRU-096's `AC13a` was "written
during implementation … without the design being consulted. The design had already answered." The
record says the opposite (the CR-CRU-096 spec, AC13a):

> *Ruled 2026-09-02 (C3 RED raised it against AC29).* The approved artifact draws `deps 091, 092`
> with this project's `CR-CRU-` prefix stripped — an abbreviation that only works for a project whose
> ids share a prefix the product cannot know. Stripping it would be exactly the project-dependence
> AC29 forbids, and a synthetic `CR-A` has no numeric tail to strip.

So the design WAS consulted and was overruled by **`AC29`**, a filed AC of CR-CRU-096: *"Crucible is
project-INDEPENDENT: its acceptance criteria state what the product guarantees for ANY board, so a
criterion that only holds while our own backlog has a given shape is not a criterion."* The
renderer's own comment carries that reasoning (`public/app.js`, the annotation slot above
`app-flow-node-cr`).

AC13a was therefore a correct resolution of a real conflict, and this CR may not simply reverse it.
What it does instead is satisfy BOTH: derive the abbreviation from the DATA rather than from
knowledge of any prefix. See §S1.

### It broke the design's load-bearing measurement, and a second invented AC papered over that

The approved design's whole argument for a **horizontal** spine is a measurement, lines 183-184:

> One CR per row, merged collapsed to the summary and only the scheduled top shown puts the box at
> **~300px** and the budget at **~600px**: the spine fits comfortably … A multi-wave ACTIVE release
> is therefore the case that widens this zone, and **the spine budget must be read per wave box**.

Measured in the user's own browser on 2026-09-03, the live wave box is **452.7px** — 50% over the
design's figure — because `CR-CRU-075` carries four dependencies and each renders as a full id. Two
such boxes exceeded the 991px surface, and the response at the time was to write **`AC19d`**, a new
"boxes WRAP onto a further line" degradation, into CR-096's spec.

That inverted the design twice over: the design had already ruled how multi-wave is handled (per
wave box, each ~300px, so they fit), and the widening it was ruled against was itself caused by an
invented AC. Restoring the bare form removes the cause, so the fallback has nothing to fall back
from.

## Scope

### §S1 — the annotation renders a DATA-DERIVED bare form, both zones

**Ruled by the user 2026-09-04.** The abbreviation is computed from the two ids in hand, never from a
prefix the product knows:

- take the row's OWN cr id and the dependency id, find their common leading text, and trim that back
  to the last character that is not a digit;
- render the dependency's remainder **only if that remainder is entirely digits**;
- otherwise render the dependency's full published id.

On this board `CR-CRU-096` beside `CR-CRU-078` yields the common prefix `CR-CRU-` and the annotation
`deps 078`, which is what the design draws. On a synthetic board `CR-W2-A` beside `CR-W1-A` leaves
`1-A`, which is not numeric, so the full id renders. The product knows no prefix; it compares the two
strings it was given. That is what makes this satisfy `AC29` rather than reverse it.

The underlying data is untouched: `dependsOn` continues to carry full ids on the wire, and every
consumer that reads them — deep links, the dependency-order warning, drill-through — continues to
read full ids. This is a rendering change only.

### §S2 — `AC19d`'s test is retired and the reversal is recorded HERE

`AC19d`'s wrap-as-degradation Chromium test is removed, and no test asserts wrapping as intended
behaviour. `AC19c` stays — the boxes lie ALONG the axis — and keeps its fit guard, which is the
assertion that actually protects the design's premise.

**Corrected 2026-09-04 by gap analysis:** this section previously also required CR-CRU-096's spec
text to be edited — `AC19d` removed and its §S6 note corrected. **CR-CRU-096 is shipped, and a
shipped CR is never edited.** That was the same defect `AC6` below was already reworded to remove,
and the same defect that made CR-CRU-099's AC8 unperformable. Tests are live artifacts and are fair
game; a merged spec is a record.

So the retirement is recorded here: **`AC19d` was an answer invented without asking, to a widening
that was itself caused by rendering full ids.** Restoring the design's bare form removes the cause,
so the fallback has nothing to fall back from. The design's own rule governs again: **the spine
budget is read per wave box.**

## Acceptance criteria

- **AC1** — On a board whose ids share a prefix with a numeric tail, zone 2's annotation renders
  `deps 078`, not `deps CR-CRU-078`; a multi-dependency row renders `deps 014, 091, 092, 095`.
  Asserted on the rendered DOM.
- **AC2** — Zone 3's depends-on cell renders the same abbreviated form under the same rule.
- **AC3** — `dependsOn` on the wire is unchanged, and every non-rendering consumer still reads full
  ids: deep-link/drill-through targeting, and the dependency-order warning naming offending pairs.
  Proven by exercising those paths, not by inspecting the payload alone.
- **AC4** — Measured in real Chromium at the design's 1130px surface: the wave box for the live
  board's widest real row (four dependencies) is at or below the design's **~300px**, and the spine
  at or below its **~600px** budget. The design's measurement becomes a test rather than a claim.
  Extends the existing `AC19c` fit guard rather than standing up new harness.
- **AC5** — `AC19d`'s wrap test is gone and no test asserts wrapping as intended behaviour. `AC19c`
  and its fit guard survive unchanged.
- **AC6** — **The product knows no id prefix.** No source or test hardcodes `CR-CRU-`, or any other
  project's prefix, to produce the abbreviation; the rule is derived from the two ids compared.
  **REWORDED twice.** It first required CR-CRU-096's `AC13a` text be "corrected in place", which
  would have edited a shipped CR. It then required AC13a's byte-exact assertions to "read the bare
  form" — also impossible: those assertions are on SYNTHETIC ids (`CR-H-A01`, `CR-W1-A`, `CR-W2-A`),
  none of which has a numeric tail, so no project-independent rule can abbreviate them. The
  superseded characterisation is recorded here instead: **AC13a resolved a genuine design-vs-AC29
  conflict in AC29's favour, and this CR resolves it in favour of both.**
- **AC7** — The existing synthetic assertions that show a full id keep showing one, unchanged,
  because their ids have no numeric tail — that is the fallback working, not a regression. Stated
  explicitly so a future reader does not "fix" them.
- **AC8** — The abbreviating path is covered by a SYNTHETIC fixture with a numeric tail, not only by
  the live board. AC29 stands: no fixture names a real CR of this project.

## Open question — NOT ruled here

With bare deps the box returns to roughly the design's ~300px, so two or three wave boxes fit the
991px surface the Project rail leaves. The design states the budget is read per wave box but does
not say what happens when a release spans **more waves than the surface can hold**. `AC19d` was an
answer invented without asking; it is being removed rather than replaced.

This CR therefore leaves the question open and does not implement any fallback. If a release ever
spans that many waves, the behaviour is the user's to decide.

## Non-goals

- **Changing `dependsOn` on the wire.** Full ids stay in the data; only the rendering changes.
- **Re-deriving or re-ordering anything.** The dependency-order warning keeps its current
  semantics; this CR touches presentation only.
- **Editing CR-CRU-096's shipped spec.** Its `AC13a` and `AC19d` text stand as the record of what
  was ruled and when. This CR supersedes their EFFECT in code and says so here; the merge and its
  record are untouched.
- **Teaching the product any project's id prefix.** See AC6. A declared-prefix wire field was
  considered and rejected as machinery out of proportion to a rendering nicety.
