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
  today marker and no traces: `forecast?release=0.3.0` answers `status: insufficient_history`
  (1 of 3 completed weeks), so `burndownData` gets no P50/P80 to plot. The cause is the velocity
  model; **CR-CRU-161** replaces it. This CR makes the chart draw what F16 shows once a forecast
  exists, and say why on its face when it does not.

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

### §S3 — labels stay inside the plot

Every step label is drawn inside the plot area. Labels that would collide are displaced within the
plot, never below or outside it.

## Acceptance criteria

- [ ] **AC1** — At a 1280 × 800 desktop viewport, the chart's canvas is at least 90% of the pane's
      content width and at least 50% of its height; it redraws to the new width on resize.
- [ ] **AC2** — With a dated forecast (fixture), the chart draws the today marker, the P50 and P80
      traces with their date labels and the target label, asserted in a real browser.
- [ ] **AC3** — With a refused forecast, the plot area states the reason, and no traces are drawn.
- [ ] **AC4** — With the 0.3.0 history (36 steps), no label is drawn outside the plot area.
- [ ] **AC5** — The live chart matches storyboard **F18 §3** (drawn 2026-09-27, the visual contract),
      including the refusal stated inside the plot, checked in a real browser at VERIFY.
