# CR-CRU-182 — a phone tap on a history cycle line opens its runs, not `→ Runs`

**Type** fix (patch CR, after the 0.3.0 release) · **Points** 3 (set at filing, 2026-10-10) ·
**Wave** 8 (0.4.0) · **Depends on** — · **Status** PENDING — filed 2026-10-10 (user ruling: the 0.3.0
follow-ups are patch CRs in wave 8)

## Problem

Found by CR-CRU-180's VERIFY (2026-10-10). At the phone band a history cycle line is its own toggle:
a tap on its empty space opens its linked runs, and a second tap closes them (F15d; CR-CRU-146).
Beside the line's timer sits the `→ Runs` badge, which navigates to the Runs tab.

WebKit, like Safari on an iPhone, moves a tap's click onto a clickable element near the finger. When
the line's label wraps, the line's empty space is reduced to a 16 px gap that borders the badge, and
a tap in that gap lands on `→ Runs`. The label wraps under DejaVu Sans Mono (the font GitHub's
runner renders) once CR-CRU-178's phone History card took 26 px of the line's width.

Measured on WebKit (CR-CRU-180 cycle 658): touch events went to `.app-cycle-line` at (305,556), the
click went to `.app-cycle-to-runs` at (296,547), and the page left Workflow for Runs.

CR-CRU-180 made the e2e step aim away from that gap, so CI is green. A real iPhone user tapping the
same spot still lands on `→ Runs`: the product's hit area is too tight, and the test no longer
covers that.

## Steps

### §S1 — the frame

F15d is amended with the phone line's hit areas: a dead zone around `→ Runs` that keeps a tap on the
line's empty space off the badge, whatever wraps. The frame is approved before RED, and it governs.

### §S2 — the line keeps its taps

The phone band lays the cycle line out as the approved frame draws it. With DejaVu fonts, a WebKit
tap anywhere in the line's empty space toggles the line, including the gap that borders the badge.
A tap on `→ Runs` itself still navigates.

## Acceptance criteria

- [ ] The F15d amendment is approved, and the phone band matches it at 390×844.
- [ ] An e2e scenario on `webkit-iphone`, with the DejaVu fonts installed (`bun run webkit:docker`
      installs them), taps the midpoint of every empty-space gap of a wrapped history cycle line,
      including the one that borders `→ Runs`. Each tap opens the line's linked runs and stays on
      Workflow; a second tap closes them.
- [ ] A tap on `→ Runs` navigates to the Runs tab (unchanged).
- [ ] The CR-CRU-146 scenario passes on `chromium-mobile` and `webkit-iphone` with its step's
      badge-avoiding gap choice removed, so the scenario taps the widest gap again, whatever it
      borders.

## How it is worked

On a feature branch, after the frame is approved: RED (the scenario above, failing on WebKit with
DejaVu), GREEN, then verify.
