# CR-CRU-160 — the burndown fills its pane and draws F16's projection

**Type** fix · **Points** 5 (planning game 2026-09-27) · **Wave** 7 (0.3.0) · **Depends on** none (CR-CRU-161 dependency dropped 2026-10-07: 0.3.0's forecast is dated without it) ·
**Status** PENDING — filed 2026-09-27

## Problem

**User defect (2026-09-27):** the release burndown (the Roadmap's analytics pane, F14¾/F16) is too
small, and compared with storyboard F16 it is missing the projection traces.

**Measured 2026-09-27 in the real browser (relay), 0.3.0 on the dev board:**

- **Fixed size.** `burndownOptions` (`public/app.js`) hard-codes `width: 560, height: 230`. The pane
  is 1193 × 1042 px, so the chart uses about a tenth of it. It never resizes.
- **Labels escape the plot.** 36 labelled steps, almost all in the last four days of a history that
  starts on 9/10, stack below the plot area and are clipped at the canvas edge (e.g.
  `−3 · CR-CRU-141 voided`).
- **No projection.** F16 draws the actual line to a `← today · 29 pts` marker, then P50 (green) and
  P80 (amber) traces from today to zero, beside a labelled `target oct 03`. The live chart has no
  today marker and no traces: `forecast?release=0.3.0` answered `status: insufficient_history`
  (1 of 3 completed weeks), so `burndownData` got no P50/P80 to plot.

**Gap analysis, 2026-10-07 (live chart in the Pi tab, `burndownOptions` / `burndownData` read):**
0.3.0's forecast is now dated (P50 10-20), so this CR no longer waits on CR-CRU-161's velocity model.
The projection F16 and F18 §3 draw is already coded: the today dot and `← today · N pts` label, the
P50/P80 series with the shaded band between them, their date labels and the target rule. What hides
it is the chart's size and its label placement: a fixed 560 × 230 canvas, and a collision rule
(`drawLabel`) that moves each colliding label down without limit, so with **63** steps (36 when this
CR was filed) the step labels, the today label and the P50/P80 labels pile up and fall below the
plot. A refused forecast is stated only in the forecast card, not in the plot.

## Scope

### §S1 — the chart fills its pane

The burndown takes the analytics pane's full content width and most of its height (the caption and
the forecast card stay visible below it without scrolling at the desktop band), and redraws when the
pane resizes. The phone band keeps CR-CRU-018's full-viewport detail-column shape.

### §S2 — F16's projection

- The actual line ends at a `← today · N pts` marker.
- When the forecast is dated, the P50 and P80 traces run from that marker to zero at their dates,
  labelled `P50 <date>` and `P80 <date>`, with the band between them shaded as in F16.
- The target line is labelled with its date (`target oct 03`).
- When the forecast refuses (`insufficient_history`, `unpointed`), the chart states the refusal in
  the plot area, where the traces would be.

### §S3 — labels stay inside the plot, and the projection's labels always show

Every label is drawn inside the plot area, never below or outside it. The today marker's label, the
P50 and P80 labels and the target label are placed first and always shown. Step labels are then
placed largest move first, each only where it fits inside the plot without overlapping a label
already placed or crossing the plotted actual line; at most the K largest moves compete for a label
(K = 8 at the desktop band, fewer when the plot is narrower), so the chart reads like F18 §3's
few-labels drawing; the steps left unlabelled are counted in one `+ N more` note inside the plot (as
in F18 §3). Every step, labelled or not, shows its full label (`−8 · CR-CRU-015 merged`) when the
pointer rests on it.

## Acceptance criteria

- [ ] **AC1** — At a 1280 × 800 desktop viewport, the chart's canvas is at least 90% of the pane's
      content width and at least 50% of its height; it redraws to the new width on resize.
- [ ] **AC2** — With a dated forecast (fixture), the chart draws the today marker, the P50 and P80
      traces with their date labels and the target label, asserted in a real browser.
- [ ] **AC3** — With a refused forecast, the plot area states the reason, and no traces are drawn.
- [ ] **AC4** — With a 63-step history (fixture), no label is drawn outside the plot area,
      overlapping another or crossing the actual line; at most K step labels are drawn (8 at the
      1280 × 800 desktop band); the today, P50, P80 and target labels are all drawn; the number of
      unlabelled steps equals the `+ N more` note's N; resting the pointer on an unlabelled step shows
      its full label, asserted in a real browser.
- [ ] **AC5** — The live chart matches storyboard **F18 §3** (drawn 2026-09-27, the visual contract),
      including the refusal stated inside the plot, checked in a real browser at VERIFY.
