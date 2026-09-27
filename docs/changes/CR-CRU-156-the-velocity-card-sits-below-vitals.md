# CR-CRU-156 — the Velocity card sits below Vitals

**Type** fix · **Points** 1 (planning game 2026-09-27) · **Wave** 7 (0.3.0) · **Depends on** — · **Status** PENDING — filed 2026-09-27

## Problem

**User defect (2026-09-27):** in the workspace's Project pane, the Velocity card should come after
the Vitals card. Today `ProjectPane` (`public/app.js`) renders, top to bottom: the Project card,
`VelocityCard()`, the agent rows, then `VitalsRail()`. Velocity sits between the Project card and
the agents, above Vitals.

## Scope

### §S1 — the pane's order

The Project pane renders the Project card, the agent rows, Vitals, then Velocity. Nothing else about
either card changes: its content, its reads and its behaviour at every responsive band (phone,
tablet, the project band, CR-CRU-018) are unchanged. Where the collapsed rail names its contents
(`Project · Vitals`), that label is checked against the new order.

## Acceptance criteria

- [ ] In the workspace Project pane, the Velocity card is rendered after the Vitals card, asserted on
      the DOM order in a real browser.
- [ ] The same order holds at the phone and tablet bands and in the relocated project band.
- [ ] The storyboard frame that shows the Project pane (F16) is updated to the new order, and
      `tests/storyboard-fidelity.test.ts` still passes.
