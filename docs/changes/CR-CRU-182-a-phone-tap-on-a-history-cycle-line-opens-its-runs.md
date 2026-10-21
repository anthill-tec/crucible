# CR-CRU-182 — a phone tap on a history cycle line opens its runs, not `→ Runs`

**Type** fix (patch CR, after the 0.3.0 release) · **Points** 8 (3 at filing; raised at gap analysis
and its pre-review 2026-10-20 as the phone rule, the touch floor and the client-run WebKit pass came
in) · **Wave** 8 (0.4.0) · **Depends on** — · **Status** DONE — merged 2026-10-21 (gate 7742/0) · filed 2026-10-10 (user ruling: the
0.3.0 follow-ups are patch CRs in wave 8)

## Problem

Found by CR-CRU-180's VERIFY (2026-10-10). At the phone band a history cycle line is its own toggle:
a tap on its empty space opens its linked runs, and a second tap closes them (F15d; CR-CRU-146).
Beside the line's timer sits the `→ Runs` badge, which navigates to the Runs tab.

WebKit, like Safari on an iPhone, moves a tap's click onto a clickable element near the finger. When
the line's label wraps, the line's empty space is reduced to a 16 px gap that borders the badge, and
a tap in that gap lands on `→ Runs`. The label wraps under DejaVu Sans Mono (the font GitHub's
runner renders) once CR-CRU-178's phone History card took 26 px of the line's width. Measured on
WebKit (CR-CRU-180 cycle 658): touch events went to `.app-cycle-line` at (305,556), the click went to
`.app-cycle-to-runs` at (296,547), and the page left Workflow for Runs.

CR-CRU-180 made the e2e step aim away from that gap, so CI is green. A real iPhone user tapping the
same spot still lands on `→ Runs`. No margin inside a phone-width line puts the line's empty space
outside WebKit's adjustment radius whatever wraps.

Three further facts (measured 2026-10-20):

- The `→ Runs` pill has no touch floor on any band: DN decision 11's "nested affordances stay
  separate ≥44px targets" was never built, for History or for Now's cycle line.
- A failed or skipped history line has `→ Runs` but no toggle; an active line with no runs opens to
  nothing.
- `bun run webkit:docker`, the one local WebKit pass, runs Playwright directly, so a WebKit run never
  reaches the board; and its container survives a never-ready server, SIGINT and SIGTERM
  (`process.exit` and a signal skip its `finally`).

## Design (settled with the user, 2026-10-20)

- At the phone band `→ Runs` lives only in a history line's expanded runs, never on the line. Every
  history line with a runs boundary expands there: done, active, failed and skipped.
- The phone choice is made in the app by `isPhoneBand()`, as the sub-tabs, roadmap cards and the
  verified-runs chip already are.
- The pill gains a ≥44px target on touch media, on every band that shows it.
- `bun run webkit:docker -- <args>` passes its arguments to `bun-crucible.py e2e`, so a WebKit run is
  filed like any other.

## Steps

### §S1 — the frame

F15d carries the amendment (closed, expanded, no runs loaded, pruned), and its superseded phone notes
are marked; F23's card c points to it. The frame is approved before RED, and it governs.

### §S2 — at the phone band the history line keeps its taps

When `isPhoneBand()` holds, a history cycle line renders no `→ Runs`. Every history line for which
`cycleHasRunsBoundary(cycle)` holds is a toggle, done, active, failed and skipped alike, and a tap
anywhere on it (its glyph, label, timer and empty space) shows or hides its expanded runs. The
expanded runs end with `→ Runs` as their own row, at least 44 px tall and their full width, rendered
whenever `cycleHasRunsBoundary(cycle)` holds, including when no run is in the loaded window (then it
sits directly under the line). The row is decided by the same predicate at the same place as the
pill (a third call, never an inline status test), navigates exactly as the pill does, and follows
the pill's pruned path: dim (`app-pill-dim`, `aria-disabled="true"`, the pruned label and title),
with the same click behaviour. Crossing the band swaps the pill and the row. Tablet and desktop
render the line's pill as today.

### §S3 — the pill is a touch target

On `(pointer: coarse)` media the `→ Runs` pill is at least 44 px tall, as `button.app-chip` and the
other touch floors are, and still reads as a pill: its horizontal padding on each side is at least
half its height, wherever it renders (History's line on tablet and desktop, Now's cycle line on every band).

### §S4 — the WebKit pass goes through the client

`bun run webkit:docker [-- <args>]` starts the pinned container, waits for it, then runs
`bun-crucible.py e2e <args> -- --project=webkit-iphone` with the run-server endpoint set, and exits
with the client's exit code. `--agent`, `--cycle` and `--release` among the arguments file the run;
without `--agent` the run is unfiled, as `e2e` is. The run also carries `webkit-iphone`'s dependency
project, which in Docker mode runs in the container's Chromium too. On every path that started a container (the run passes,
it fails, the server never becomes ready, SIGINT, SIGTERM) the container is removed; on a signal the
client is let finish filing its abandoned run first. The client runs in its own process group, so a
signal reaches it once, by the script's forward, never also from the terminal. Docker unreachable and a failed `docker run`
still exit non-zero naming the remedy. The script's own `bddgen` step is dropped (the client's
`test:e2e` runs it).

### §S5 — the design record follows

DN-crucible-responsive-model decision 11 states the phone band's rule, and its WebKit provisioning
section says the Docker pass runs through the client and is filed.

## Acceptance criteria

- [x] **The frame.** The F15d amendment is approved before RED. At the end, the user (or VERIFY with
      screenshots from `webkit-iphone` at 393×659 and `chromium-mobile` at 412×839) confirms the
      phone band matches its closed, expanded, no-runs and pruned drawings.
- [x] **The phone line keeps its taps.** An e2e scenario on `webkit-iphone` (DejaVu installed by the
      Docker path and by CI) and on `chromium-mobile` renders a history cycle line whose label is
      asserted to wrap (the scenario fails if it does not), with no `→ Runs` on the closed line. A
      tap at the midpoint of every horizontal gap wider than 0 px not covered by a child of the line,
      at its vertical centre (including the gap between the timer and the `▸ N runs` hint), and a tap
      on the label and on the timer, each shows the expanded runs and stays on Workflow; a second
      tap, at the same gap re-measured after the line changes, hides them.
- [x] **Every boundary expands.** On the phone band a failed and a skipped history cycle line each
      expands on a tap and shows the `→ Runs` row; an active history line with no runs expands to
      the row alone (unit tests forcing the band with an inline `--band: phone`).
- [x] **The row navigates.** On the phone band the `→ Runs` row measures at least 44 px tall and the
      expanded runs' full width, and a tap on it shows the Runs tab with the boundary in view (e2e);
      for a pruned boundary the row renders `app-pill-dim`, `aria-disabled="true"` and the pruned
      label and title, and a click still shows the Runs tab (unit).
- [x] **Bands swap.** With the band switched from phone to tablet the line renders the pill and no
      row, and back again (unit).
- [x] **Tablet and desktop unchanged.** There the history line renders its `→ Runs` pill, and every
      existing `→ Runs` test passes unchanged.
- [x] **The pill is a touch target.** On a `(pointer: coarse)` profile at tablet width the history
      pill, and on the phone and tablet bands Now's cycle-line pill, each measure at least 44 px
      tall, with horizontal padding on each side of at least half that height.
- [x] **The CR-CRU-146 step aims at the widest gap.** Its phone step's gap search references no
      `cycle-to-runs`, and the CR-CRU-146 scenarios pass on `chromium-mobile`, `webkit-iphone` and
      desktop Chromium.
- [x] **WebKit runs through the client.** `bun run webkit:docker -- --agent X` runs the `webkit-iphone`
      project through `bun-crucible.py e2e`, files the run, and exits with its code. Through a
      testable seam, the container is removed on a pass, a failure, a server that never becomes
      ready, SIGINT and SIGTERM (after the client files on a signal), and no container is started
      when Docker is unreachable; the client is spawned in its own process group, so a signal reaches
      it only by the forward.
- [x] **The record.** DN decision 11 and the WebKit provisioning section say what §S5 says.

## Non-goals

- Moving `→ Runs` off the line at tablet or desktop, or off Now's line on any band.
- A WebKit pass in the pre-merge gate (e2e stays outside it fleet-wide).
