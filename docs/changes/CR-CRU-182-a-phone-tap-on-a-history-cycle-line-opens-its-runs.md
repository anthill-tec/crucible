# CR-CRU-182 — a phone tap on a history cycle line opens its runs, not `→ Runs`

**Type** fix (patch CR, after the 0.3.0 release) · **Points** 5 (3 at filing; raised at gap analysis
2026-10-20 when the WebKit pass moved onto the client) · **Wave** 8 (0.4.0) · **Depends on** — ·
**Status** PENDING — filed 2026-10-10 (user ruling: the 0.3.0 follow-ups are patch CRs in wave 8)

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
same spot still lands on `→ Runs`. No margin inside a 390 px line is wide enough to put the line's
empty space outside WebKit's adjustment radius whatever wraps, and F15d's "the Runs badge keeps its
own 44px target" was never built: the phone band gives `.app-cycle-to-runs` no touch floor.

`bun run webkit:docker`, the one local WebKit pass, runs Playwright directly, so a WebKit run never
reaches the board.

## Design (settled with the user, 2026-10-20)

- At the phone band a closed history cycle line carries no `→ Runs`: nothing clickable borders its
  empty space. The open span ends with `→ Runs` as its own full-width row of at least 44 px.
  Desktop and tablet keep the line's pill.
- `bun run webkit:docker` runs the `webkit-iphone` project through the bun client.

## Steps

### §S1 — the frame

F15d carries the amendment: the phone band's closed and open history line as drawn above. The
frame is approved before RED, and it governs.

### §S2 — the line keeps its taps

At the phone band (`width <= 640px`) a history cycle line renders no `→ Runs` badge, whatever its
state, and a tap anywhere on it toggles its linked runs. The open span renders `→ Runs` as its last
row, at least 44 px tall and the span's full width, with the same navigation and the same pruned-
boundary dim state the pill has. Tablet and desktop render the line's pill as today.

### §S3 — the WebKit pass goes through the client

`bun run webkit:docker` starts the pinned container as today, then runs
`bun-crucible.py e2e -- --project=webkit-iphone` against it, with the run filed on the board when an
agent is given (the variable the script reads is named in its help). It still tears the container
down on every exit path and fails loudly, naming the remedy, when Docker is unreachable.

## Acceptance criteria

- [ ] The F15d amendment is approved, and the phone band matches it at 390×844.
- [ ] An e2e scenario on `webkit-iphone`, with the DejaVu fonts installed, taps the midpoint of every
      empty-space gap of a wrapped history cycle line, including the gap at its right-hand end. Each
      tap opens the line's linked runs and stays on Workflow; a second tap closes them. The closed
      line renders no `→ Runs`.
- [ ] On the phone band, the open span's `→ Runs` row measures at least 44 px tall and the span's
      full width, and a tap on it navigates to the Runs tab with the boundary in view; a pruned
      boundary renders it dim and inert, as the pill is.
- [ ] On tablet and desktop the line still renders its `→ Runs` pill, and clicking it navigates
      (unchanged).
- [ ] The CR-CRU-146 phone scenario passes on `chromium-mobile` and `webkit-iphone` with its step's
      badge-avoiding gap choice removed, so it taps the widest gap again.
- [ ] `bun run webkit:docker` runs the `webkit-iphone` project through `bun-crucible.py e2e`, files
      the run on the board when the agent variable is set, and removes the container on success,
      failure and interrupt.

## Non-goals

- Moving `→ Runs` off the line at tablet or desktop.
- A WebKit pass in the pre-merge gate (e2e stays outside it fleet-wide).
